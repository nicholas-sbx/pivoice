/**
 * The low-latency engine's network half, in a dedicated worker so nothing
 * the page does (rendering, layout, Vue) can delay a packet:
 *
 *   pv-capture worklet ──frames──▶ here: our silence gate, WebCodecs encode,
 *                                  packet (+ redundancy) ──▶ data channels
 *   data channels ──packets──▶ here: WebCodecs decode ──pcm──▶ each person's
 *                                  pv-playback worklet
 *
 * The data channels are transferred in at creation (Chrome allows that
 * only then). Where a browser can't transfer them the page relays packets
 * instead, through the same messages.
 */
/// <reference lib="webworker" />
import { LOOP_ID, type LLConfig } from './config'
import { PING, PONG, Unwrapper, bytesToPcm, decodePacket, decodePing, encodePacket, encodePing, pcmToBytes, type Frame } from './packet'
import { FrameRing, RING_MAX_FRAME, RING_SLOTS } from './ring'
import type { CaptureFrame, PlaybackMessage } from './worklet'

declare const self: DedicatedWorkerGlobalScope

export type ToWorker =
  /** `ring`: when the page is cross-origin isolated, capture comes through shared memory instead of `capture`. */
  | { type: 'init'; cfg: LLConfig; capture: MessagePort; ring?: SharedArrayBuffer }
  | { type: 'config'; cfg: LLConfig }
  | { type: 'active'; on: boolean }
  | { type: 'gate'; muted: boolean; deafened: string[] }
  | { type: 'clock'; frame: number; epochMs: number; outMs: number; inMs: number }
  | { type: 'channel'; id: string; ch: RTCDataChannel }
  | { type: 'relayed'; id: string }
  | { type: 'packet'; id: string; buf: ArrayBuffer }
  /** `ring`: decoded audio for this person goes into shared memory their playback worklet reads, instead of `port`. */
  | { type: 'remote'; id: string; port: MessagePort; ring?: SharedArrayBuffer }
  | { type: 'drop'; id: string }
  | { type: 'stats' }
  /** Mic test: also feed what we send straight back into our own receive side, as LOOP_ID. */
  | { type: 'loop'; on: boolean }


export interface WorkerRemoteStats {
  kbps: number | null
  /** What they're sending: from the newest packet's flag. */
  codec: 'opus' | 'pcm' | null
  /** Their newest capture stamp: their sample clock and wall-clock ms. */
  stamp: { ts: number; ms: number } | null
  /** Round trip over this channel, ms: the median of the last few pings. */
  rttMs: number | null
}

export type FromWorker =
  | { type: 'link'; id: string; up: boolean }
  | { type: 'send'; to: string[]; buf: ArrayBuffer }
  | { type: 'stats'; remotes: Record<string, WorkerRemoteStats> }

const SR = 48_000
const STAMP_EVERY = 20
/** Skip a packet rather than queue it behind this much unsent data: queued audio is late audio. */
const MAX_BUFFERED_BYTES = 16 * 1024
/**
 * Ping everyone this often over their channel. That's how ping is measured
 * for people on this engine: getStats() on the peer connection would do,
 * but in Chrome it stalls the network thread the packets come in on, and
 * the jitter buffer pays for that once a second.
 */
const PING_EVERY_MS = 1000
const RTT_SAMPLES = 5

interface Remote {
  port: MessagePort | null
  ring: FrameRing | null
  decoder: AudioDecoder | null
  decoding: number[]
  unwrap: Unwrapper
  lastDecoded: number
  bytes: number
  bytesAt: number
  stamp: { ts: number; ms: number } | null
  codec: 'opus' | 'pcm' | null
  rtts: number[]
}

let cfg: LLConfig
let active = false
let muted = false
let loop = false
let deafened = new Set<string>()
let clock: { frame: number; epochMs: number; outMs: number; inMs: number } | null = null
const channels = new Map<string, RTCDataChannel | 'relayed'>()
const remotes = new Map<string, Remote>()

// ---- sending ---------------------------------------------------------------

/**
 * Chrome's encoder (like its decoder) numbers its output itself, counting
 * frames from the first input and ignoring any gap in the timestamps we
 * give it. So we remember which capture time went in as its n-th frame,
 * and never use its own DTX (which drops frames from that count).
 */
let encoder: AudioEncoder | null = null
let encStartUs: number | null = null
let encCount = 0
let encFrameUs = 0
const encPending = new Map<number, number>()
let history: Frame[] = []
let sent = 0
let quietFor = 0

function post(msg: FromWorker, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer)
}

function makeEncoder(): AudioEncoder {
  const enc = new AudioEncoder({
    output: chunk => onEncoded(chunk),
    error: e => {
      console.warn('low-latency encoder failed', e)
      if (encoder === enc) closeEncoder()
    }
  })
  enc.configure({
    codec: 'opus',
    sampleRate: SR,
    numberOfChannels: 1,
    bitrate: cfg.bitrateKbps * 1000,
    opus: {
      frameDuration: cfg.frameMs * 1000,
      complexity: cfg.complexity,
      usedtx: false,
      useinbandfec: false,
      packetlossperc: 0,
      // In the spec and in Chrome, not yet in every TypeScript lib.
      ...({ application: cfg.application, signal: 'voice' } as object)
    }
  } as AudioEncoderConfig)
  return enc
}

function closeEncoder() {
  const enc = encoder
  encoder = null
  if (enc && enc.state !== 'closed') enc.close()
  encStartUs = null
  encCount = 0
  encPending.clear()
  history = []
}

/**
 * Our DTX: skip a frame once you've been below the threshold for a moment.
 * Each frame decides from its own level, so the first frame with any sound
 * in it goes out (nothing waits on a detector), and the hangover keeps the
 * tails of words.
 */
function isSilence(pcm: Float32Array): boolean {
  let sum = 0
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i]
  const db = 10 * Math.log10(sum / pcm.length + 1e-12)
  if (db >= cfg.dtxThresholdDb) {
    quietFor = 0
    return false
  }
  quietFor += pcm.length
  return quietFor > cfg.dtxHangoverMs * 48
}

function encode(f: CaptureFrame) {
  if (!active || !cfg || (muted && !loop)) return
  if (cfg.dtx && isSilence(f.pcm)) return
  if (cfg.codec === 'pcm') {
    // No encoder: the samples go out as they are, the moment they're captured.
    emit({ ts: f.ts, data: pcmToBytes(f.pcm) }, true)
    return
  }
  encoder ??= makeEncoder()
  const us = Math.round((f.ts * 1e6) / SR)
  if (encStartUs === null) {
    encStartUs = us
    encFrameUs = (f.pcm.length * 1e6) / SR
  }
  encPending.set(encCount++, f.ts)
  const data = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: f.pcm.length, numberOfChannels: 1, timestamp: us, data: f.pcm })
  try {
    encoder.encode(data)
  } finally {
    data.close()
  }
}

function onEncoded(chunk: EncodedAudioChunk) {
  if (!active || encStartUs === null) return
  const n = Math.round((chunk.timestamp - encStartUs) / encFrameUs)
  const ts = encPending.get(n)
  for (const k of encPending.keys()) {
    if (k > n) break
    encPending.delete(k)
  }
  if (ts === undefined) return
  const data = new Uint8Array(chunk.byteLength)
  chunk.copyTo(data)
  emit({ ts, data }, false)
}

/** A finished frame: add the repeats of the ones before it, now and then a capture stamp, and send. */
function emit(frame: Frame, pcm: boolean) {
  const frames = [...history.slice(history.length - cfg.redundancy), frame]
  history.push(frame)
  if (history.length > 2) history.shift()
  const stamp = sent++ % STAMP_EVERY === 0 ? captureEpoch(frame.ts) : null
  send(encodePacket(frames, stamp, pcm))
}

/** Wall-clock time a sample on our audio clock was captured at the mic. */
function captureEpoch(frame: number): number | null {
  if (!clock) return null
  return clock.epochMs + ((frame - clock.frame) * 1000) / SR - clock.outMs - clock.inMs
}

function send(buf: ArrayBuffer) {
  // The mic test hears exactly what would have gone out, through the same decode and jitter buffer.
  if (loop) receive(LOOP_ID, buf.slice(0))
  if (muted) return
  const relay: string[] = []
  for (const [id, ch] of channels) {
    if (deafened.has(id)) continue
    if (ch === 'relayed') {
      relay.push(id)
      continue
    }
    if (ch.readyState !== 'open' || ch.bufferedAmount > MAX_BUFFERED_BYTES) continue
    try {
      ch.send(buf)
    } catch {
      /* closing */
    }
  }
  if (relay.length) post({ type: 'send', to: relay, buf }, [buf])
}

// ---- receiving -------------------------------------------------------------

function remote(id: string): Remote {
  let r = remotes.get(id)
  if (!r) {
    r = { port: null, ring: null, decoder: null, decoding: [], unwrap: new Unwrapper(), lastDecoded: -Infinity, bytes: 0, bytesAt: performance.now(), stamp: null, codec: null, rtts: [] }
    remotes.set(id, r)
  }
  return r
}

function makeDecoder(r: Remote): AudioDecoder {
  const dec = new AudioDecoder({
    output: a => {
      const pcm = new Float32Array(a.numberOfFrames)
      a.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' })
      a.close()
      // Its own timestamps count frames from the first and ignore gaps; ours don't.
      const ts = r.decoding.shift()
      if (ts !== undefined) deliver(r, ts, pcm)
    },
    error: e => {
      console.warn('low-latency decoder failed', e)
      if (r.decoder === dec) {
        r.decoder = null
        r.decoding = []
      }
    }
  })
  dec.configure({ codec: 'opus', sampleRate: SR, numberOfChannels: 1 })
  return dec
}

/** Decoded audio to their playback worklet: shared memory if we have it, a message if not. */
function deliver(r: Remote, ts: number, pcm: Float32Array<ArrayBuffer>) {
  if (r.ring) {
    if (pcm.length <= RING_MAX_FRAME) r.ring.push(ts, pcm)
  } else r.port?.postMessage({ type: 'frame', ts, pcm } satisfies PlaybackMessage, [pcm.buffer])
}

/** One message to one person, on their channel or through the page. */
function sendTo(id: string, buf: ArrayBuffer) {
  const ch = channels.get(id)
  if (ch === 'relayed') post({ type: 'send', to: [id], buf }, [buf])
  else if (ch?.readyState === 'open') {
    try {
      ch.send(buf)
    } catch {
      /* closing */
    }
  }
}

function onPing(id: string, kind: number, sentMs: number) {
  if (kind === PING) {
    sendTo(id, encodePing(PONG, sentMs))
    return
  }
  const rtt = performance.now() - sentMs
  if (!(rtt >= 0 && rtt < 10_000)) return
  const r = remote(id)
  r.rtts.push(rtt)
  if (r.rtts.length > RTT_SAMPLES) r.rtts.shift()
}

setInterval(() => {
  const now = performance.now()
  for (const id of channels.keys()) if (id !== LOOP_ID) sendTo(id, encodePing(PING, now))
}, PING_EVERY_MS)

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function receive(id: string, buf: ArrayBuffer) {
  const ping = decodePing(buf)
  if (ping) {
    onPing(id, ping.kind, ping.sentMs)
    return
  }
  const pkt = decodePacket(buf)
  if (!pkt) return
  const r = remote(id)
  r.bytes += buf.byteLength
  r.codec = pkt.pcm ? 'pcm' : 'opus'
  const frames = pkt.frames.map(f => ({ ts: r.unwrap.unwrap(f.ts), data: f.data }))
  if (pkt.captureMs !== null && frames.length) r.stamp = { ts: frames[frames.length - 1].ts, ms: pkt.captureMs }
  if (pkt.pcm) {
    for (const f of frames) {
      if (f.ts <= r.lastDecoded) continue
      r.lastDecoded = f.ts
      deliver(r, f.ts, bytesToPcm(f.data))
    }
    return
  }
  r.decoder ??= makeDecoder(r)
  // Oldest first: a repeat of a frame we missed goes in before the new one.
  for (const f of frames) {
    if (f.ts <= r.lastDecoded) continue
    r.lastDecoded = f.ts
    r.decoding.push(f.ts)
    r.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round((f.ts * 1e6) / SR), data: f.data }))
  }
}

function adopt(id: string, ch: RTCDataChannel) {
  const old = channels.get(id)
  if (old && old !== 'relayed') old.close()
  channels.set(id, ch)
  ch.binaryType = 'arraybuffer'
  const up = () => channels.get(id) === ch && post({ type: 'link', id, up: true })
  if (ch.readyState === 'open') up()
  else ch.onopen = up
  ch.onmessage = e => {
    if (e.data instanceof ArrayBuffer) receive(id, e.data)
  }
  ch.onclose = () => {
    if (channels.get(id) !== ch) return
    channels.delete(id)
    post({ type: 'link', id, up: false })
  }
}

function drop(id: string) {
  const ch = channels.get(id)
  channels.delete(id)
  if (ch && ch !== 'relayed') ch.close()
  const r = remotes.get(id)
  remotes.delete(id)
  if (r?.decoder && r.decoder.state !== 'closed') r.decoder.close()
  r?.port?.close()
}

/**
 * Capture through shared memory: sleep until the capture worklet publishes
 * a frame, then take everything waiting. waitAsync keeps the worker free
 * for its data channels in between.
 */
type AtomicsWithWaitAsync = {
  waitAsync(a: Int32Array, i: number, v: number): { async: false; value: string } | { async: true; value: Promise<string> }
}

async function pumpCapture(ring: FrameRing) {
  for (;;) {
    const seen = ring.written
    ring.drain((ts, pcm) => encode({ ts, pcm: new Float32Array(pcm) }))
    const wait = (Atomics as unknown as AtomicsWithWaitAsync).waitAsync(ring.ctrl, 0, seen)
    if (wait.async) await wait.value
  }
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data
  switch (m.type) {
    case 'init':
      cfg = m.cfg
      m.capture.onmessage = (ev: MessageEvent<CaptureFrame>) => encode(ev.data)
      if (m.ring) void pumpCapture(FrameRing.from(m.ring, RING_SLOTS, RING_MAX_FRAME))
      return
    case 'config': {
      const prev = cfg
      cfg = m.cfg
      if (
        prev.frameMs !== cfg.frameMs ||
        prev.application !== cfg.application ||
        prev.bitrateKbps !== cfg.bitrateKbps ||
        prev.complexity !== cfg.complexity
      )
        closeEncoder()
      return
    }
    case 'active':
      if (active === m.on) return
      active = m.on
      // A fresh encoder each time we start, so its numbering starts with us.
      if (!active) closeEncoder()
      return
    case 'loop':
      loop = m.on
      return
    case 'gate':
      if (m.muted && !muted && !loop) closeEncoder()
      muted = m.muted
      deafened = new Set(m.deafened)
      return
    case 'clock':
      clock = { frame: m.frame, epochMs: m.epochMs, outMs: m.outMs, inMs: m.inMs }
      return
    case 'channel':
      adopt(m.id, m.ch)
      return
    case 'relayed':
      channels.set(m.id, 'relayed')
      return
    case 'packet':
      receive(m.id, m.buf)
      return
    case 'remote': {
      const r = remote(m.id)
      r.port?.close()
      r.port = m.port
      r.ring = m.ring ? FrameRing.from(m.ring, RING_SLOTS, RING_MAX_FRAME) : null
      return
    }
    case 'drop':
      drop(m.id)
      return
    case 'stats': {
      const now = performance.now()
      const out: Record<string, WorkerRemoteStats> = {}
      for (const [id, r] of remotes) {
        const seconds = (now - r.bytesAt) / 1000
        out[id] = { kbps: seconds > 0 ? (r.bytes * 8) / 1000 / seconds : null, stamp: r.stamp, codec: r.codec, rttMs: median(r.rtts) }
        r.bytes = 0
        r.bytesAt = now
      }
      post({ type: 'stats', remotes: out })
      return
    }
  }
}
