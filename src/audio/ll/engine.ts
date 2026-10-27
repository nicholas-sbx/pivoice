import workletUrl from './worklet.ts?worker&url'
import LLWorker from './worker.ts?worker'
import { LOOP_ID, captureFrame, type LLConfig } from './config'
import { FrameRing, RING_MAX_FRAME, RING_SLOTS } from './ring'
import type { JitterConfig, JitterStats } from './jitter'
import type { FromWorker, ToWorker, WorkerRemoteStats } from './worker'
import type { CaptureMessage, PlaybackMessage } from './worklet'

/**
 * The experimental low-latency engine, main-thread half: it sets things up
 * and stays out of the way.
 *
 * WebRTC's audio path has costs a page can't touch: 10 ms frames at the
 * least, its jitter buffer (NetEq, ~25 ms floor here), and its own capture
 * and playout buffering. This replaces all of it for pairs of people who
 * both turn it on:
 *
 *   mic → pv-capture worklet (frames of 2.5–20 ms on the audio clock)
 *       → worker: WebCodecs Opus (the browser's own libopus), our silence
 *         gate, packets with redundancy → data channels that are unordered
 *         and never retransmit, so late is dropped, never queued
 *   data channels → worker: WebCodecs decode → pv-playback worklet (our
 *       JitterBuffer) → that person's channel strip in AudioEngine
 *
 * The main thread isn't in that path at all, so page work (rendering,
 * layout) can't add jitter. Every so often a packet carries the wall-clock
 * capture time of its newest frame, which is how the receiving end measures
 * the whole path, mic to speakers (exact on one machine; across machines,
 * as good as your clocks).
 */

export interface LLRemoteStats extends JitterStats {
  kbps: number | null
  /** What they're sending us. */
  codec: 'opus' | 'pcm' | null
  /** One way, sender's capture to our speakers, ms. Needs their capture stamps. */
  measuredMs: number | null
}

export interface LLEngineEvents {
  /** A channel the worker holds opened or closed. */
  link(id: string, up: boolean): void
  /** Relay mode only (channels that couldn't move to the worker): send this on these. */
  relay(to: string[], buf: ArrayBuffer): void
}

interface Remote {
  node: AudioWorkletNode
  stats: JitterStats | null
  worker: WorkerRemoteStats | null
  measured: number[]
}

const SR = 48_000

export class LowLatencyEngine {
  static supported(): boolean {
    return (
      typeof AudioEncoder !== 'undefined' &&
      typeof AudioDecoder !== 'undefined' &&
      typeof AudioWorkletNode !== 'undefined' &&
      typeof Worker !== 'undefined'
    )
  }

  /**
   * Shared memory between the worklets and the worker when the page is
   * cross-origin isolated (the Worker sends the headers); messages when not.
   */
  readonly transport: 'shared' | 'messages' = typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated ? 'shared' : 'messages'
  private worker: Worker
  private ready: Promise<void>
  private capture: AudioWorkletNode | null = null
  private sink: GainNode
  private mic: AudioNode | null = null
  /** What the call wants (someone listening), and whether the mic test is running: either keeps capture on. */
  private wanted = false
  private looping = false
  private active = false
  private remotes = new Map<string, Remote>()
  private clockTimer: ReturnType<typeof setInterval>
  private closed = false
  /** Your mic's input latency, ms, as the browser reports it (for the capture stamp). */
  inputLatencyMs: () => number = () => 0

  constructor(
    private ctx: AudioContext,
    private cfg: LLConfig,
    private events: LLEngineEvents
  ) {
    // A plain copy: what we're given may be a Vue proxy, which can't be posted.
    this.cfg = { ...cfg }
    this.worker = new LLWorker()
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onWorker(e.data)
    const capture = new MessageChannel()
    const captureRing = this.transport === 'shared' ? FrameRing.create(RING_SLOTS, RING_MAX_FRAME) : null
    this.toWorker({ type: 'init', cfg: this.cfg, capture: capture.port2, ring: captureRing?.sab }, [capture.port2])

    // The capture node must be pulled to run; a silent gain to the speakers does that.
    this.sink = ctx.createGain()
    this.sink.gain.value = 0
    this.sink.connect(ctx.destination)
    this.ready = ctx.audioWorklet.addModule(workletUrl).then(() => {
      if (this.closed) return
      this.capture = new AudioWorkletNode(ctx, 'pv-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { frame: captureFrame(this.cfg), active: this.active, ring: captureRing?.sab }
      })
      this.capture.port.postMessage({ out: capture.port1 } satisfies CaptureMessage, [capture.port1])
      this.capture.connect(this.sink)
      this.mic?.connect(this.capture)
    })
    // The worker stamps capture times; it needs our audio clock against the wall clock.
    this.clockTimer = setInterval(() => this.sendClock(), 500)
    this.sendClock()
  }

  private toWorker(msg: ToWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(msg, transfer)
  }

  private sendClock() {
    const t = this.ctx.getOutputTimestamp()
    if (t.contextTime === undefined || t.performanceTime === undefined) return
    this.toWorker({
      type: 'clock',
      frame: t.contextTime * SR,
      epochMs: performance.timeOrigin + t.performanceTime,
      outMs: (this.ctx.baseLatency + (this.ctx.outputLatency || 0)) * 1000,
      inMs: this.inputLatencyMs()
    })
  }

  /** Wall-clock time a sample on our audio clock reaches the speakers, ms since the epoch. */
  private outputEpoch(frame: number): number {
    const t = this.ctx.getOutputTimestamp()
    return performance.timeOrigin + (t.performanceTime ?? performance.now()) + (frame / SR - (t.contextTime ?? this.ctx.currentTime)) * 1000
  }

  private onWorker(m: FromWorker) {
    if (m.type === 'link') this.events.link(m.id, m.up)
    else if (m.type === 'send') this.events.relay(m.to, m.buf)
    else if (m.type === 'stats') {
      for (const [id, s] of Object.entries(m.remotes)) {
        const r = this.remotes.get(id)
        if (r) r.worker = s
      }
    }
  }

  setMic(mic: AudioNode | null) {
    if (this.mic && this.capture) {
      try {
        this.mic.disconnect(this.capture)
      } catch {
        /* wasn't connected */
      }
    }
    this.mic = mic
    if (mic && this.capture) mic.connect(this.capture)
  }

  /** Only capture and encode while someone's listening on this engine (or the mic test is). */
  setActive(want: boolean) {
    this.wanted = want
    const on = want || this.looping
    if (on === this.active) return
    this.active = on
    void this.ready.then(() => this.capture?.port.postMessage({ active: this.active } satisfies CaptureMessage))
    this.toWorker({ type: 'active', on })
  }

  /** Who not to send to (deafened), and whether we send at all (muted). */
  setGate(muted: boolean, deafened: string[]) {
    this.toWorker({ type: 'gate', muted, deafened })
  }

  configure(cfg: LLConfig) {
    const prev = this.cfg
    this.cfg = { ...cfg }
    this.toWorker({ type: 'config', cfg: this.cfg })
    if (captureFrame(prev) !== captureFrame(cfg)) this.capture?.port.postMessage({ frame: captureFrame(cfg) } satisfies CaptureMessage)
    const jitter = jitterConfig(cfg)
    for (const r of this.remotes.values()) r.node.port.postMessage({ type: 'config', jitter } satisfies PlaybackMessage)
  }

  /**
   * Hand a just-created data channel to the worker. Chrome only allows that
   * before anything else touches it; if the browser can't, returns false
   * and the caller relays with packet() and the relay event instead.
   */
  adoptChannel(id: string, ch: RTCDataChannel): boolean {
    try {
      this.toWorker({ type: 'channel', id, ch }, [ch as unknown as Transferable])
      return true
    } catch {
      this.toWorker({ type: 'relayed', id })
      return false
    }
  }

  /** Relay mode: a packet that arrived on the page's copy of the channel. */
  packet(id: string, buf: ArrayBuffer) {
    this.toWorker({ type: 'packet', id, buf }, [buf])
  }

  /** A playback node for someone, to plug into their channel strip. */
  async addRemote(id: string): Promise<AudioNode | null> {
    await this.ready
    if (this.closed) return null
    const existing = this.remotes.get(id)
    if (existing) return existing.node
    const ring = this.transport === 'shared' ? FrameRing.create(RING_SLOTS, RING_MAX_FRAME) : null
    const node = new AudioWorkletNode(this.ctx, 'pv-playback', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { jitter: jitterConfig(this.cfg), ring: ring?.sab }
    })
    // Decoded audio goes straight from the worker to the node.
    const pipe = new MessageChannel()
    node.port.postMessage({ type: 'port', port: pipe.port1 } satisfies PlaybackMessage, [pipe.port1])
    this.toWorker({ type: 'remote', id, port: pipe.port2, ring: ring?.sab }, [pipe.port2])
    const r: Remote = { node, stats: null, worker: null, measured: [] }
    node.port.onmessage = (e: MessageEvent<{ type: 'stats' } & JitterStats>) => {
      if (e.data.type !== 'stats') return
      r.stats = e.data
      const stamp = r.worker?.stamp
      if (stamp && e.data.playTs !== null) {
        const captured = stamp.ms + ((e.data.playTs - stamp.ts) * 1000) / SR
        const heard = this.outputEpoch(e.data.atFrame)
        r.measured.push(heard - captured)
        if (r.measured.length > 5) r.measured.shift()
      }
    }
    this.remotes.set(id, r)
    return node
  }

  removeRemote(id: string) {
    const r = this.remotes.get(id)
    this.toWorker({ type: 'drop', id })
    if (!r) return
    this.remotes.delete(id)
    r.node.port.onmessage = null
    r.node.disconnect()
  }

  /**
   * Mic test: our own audio through the whole engine (gate, encode,
   * packet, decode, jitter buffer) and out to `out`, no network. Its stats
   * come back under LOOP_ID.
   */
  async startLoop(out: AudioNode) {
    this.looping = true
    this.setActive(this.wanted)
    const node = await this.addRemote(LOOP_ID)
    if (!this.looping || !node) return
    node.connect(out)
    this.toWorker({ type: 'loop', on: true })
  }

  stopLoop() {
    if (!this.looping) return
    this.looping = false
    this.toWorker({ type: 'loop', on: false })
    this.removeRemote(LOOP_ID)
    this.setActive(this.wanted)
  }

  /** Ask the worker for fresh numbers; stats() returns the last ones it sent. */
  refresh() {
    this.toWorker({ type: 'stats' })
  }

  stats(id: string): LLRemoteStats | null {
    const r = this.remotes.get(id)
    if (!r?.stats) return null
    const sorted = [...r.measured].sort((a, b) => a - b)
    return { ...r.stats, kbps: r.worker?.kbps ?? null, codec: r.worker?.codec ?? null, measuredMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null }
  }

  close() {
    this.closed = true
    clearInterval(this.clockTimer)
    this.worker.terminate()
    for (const r of this.remotes.values()) r.node.disconnect()
    this.remotes.clear()
    this.capture?.disconnect()
    this.sink.disconnect()
  }
}

export function jitterConfig(cfg: LLConfig): Omit<JitterConfig, 'sampleRate'> {
  return {
    minMs: cfg.minBufferMs,
    maxMs: cfg.maxBufferMs,
    marginMs: cfg.marginMs,
    multiplier: cfg.jitterMultiplier,
    stretch: cfg.stretchPct / 100,
    concealMs: cfg.concealMs,
    percentile: cfg.jitterPercentile,
    windowSec: cfg.jitterWindowSec
  }
}
