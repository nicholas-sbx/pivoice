/**
 * The caption worker, apart from the recogniser itself (vosk.worker.ts,
 * parakeet.worker.ts each bring theirs, so neither loads the other's code):
 *
 *   model:  check the cache against the pinned hashes; if anything's
 *           missing, say how much and wait to be told to download it
 *           (the page decides, by the network: see network.ts)
 *   audio:  what the caption worklet's gate lets through, 48 kHz, in
 *           segments → 16 kHz (decimate.ts) → the recogniser
 *   words:  partial and finished phrases back to the page, numbered
 *
 * The recogniser only ever works on a segment: what the gate let through
 * (your ring lit, plus the pre-roll and post-roll) and the segment's end.
 * Between segments nothing arrives, so nothing runs: no Vosk calls, no
 * Parakeet reads or re-reads, not even a timer. That's the CPU's sake as
 * much as privacy's; the only always-on work while captions listen is the
 * worklet keeping the pre-roll and measuring the level, and with captions
 * off or you muted the worklet is switched off too.
 *
 * On a slow machine (CPU only, which is everyone in a browser: nothing
 * here asks for a GPU) audio waits in the ring, up to 5 s of it, rather
 * than being lost, and the live re-reads are skipped while it's behind:
 * finished phrases come first.
 */
/// <reference lib="webworker" />
import { FrameRing } from '../audio/ll/ring'
import { CAPTION_RATE } from './config'
import { Decimator } from './decimate'
import { cachedFiles, checkManifest, downloadBytes, downloadFile, modelOf, readCached, type CatalogModel, type ModelId } from './models'
import { CAPTION_FRAME, CAPTION_SLOTS, type CaptionTapFrame } from './tap'

declare const self: DedicatedWorkerGlobalScope

export interface WorkerConfig {
  partials: boolean
  partialsPerSec: number
  rereadMs: number
  maxPhraseSec: number
  minConfidence: number
}

export type ModelPhase = 'checking' | 'needed' | 'downloading' | 'loading' | 'ready' | 'error'

export interface ModelStatus {
  phase: ModelPhase
  /** Downloaded so far, and in all (what's still missing, compressed). */
  bytes: number
  total: number
  error?: string
}

export type ToCaptionWorker =
  | { type: 'init'; model: ModelId; base: string; cfg: WorkerConfig; ring?: SharedArrayBuffer; port?: MessagePort }
  /** Go ahead and download what's missing. */
  | { type: 'download' }
  | { type: 'config'; cfg: WorkerConfig }

export type FromCaptionWorker =
  | { type: 'model'; status: ModelStatus }
  | { type: 'text'; u: number; text: string; final: boolean }
  /** rtf: seconds of work per second of speech lately (under 1 keeps up). */
  | { type: 'stats'; rtf: number | null; lost: number }

/** A recogniser, fed one phrase at a time. */
export interface Recogniser {
  /** Recognises as it goes (Vosk), or a phrase at a time (Parakeet: partial() reads it all again). */
  readonly streaming: boolean
  /** Audio held for the phrase so far, samples. */
  readonly held: number
  /** More of the phrase, 16 kHz, [-1, 1]. True: it finished a phrase by itself (a pause); take it with result(). */
  accept(pcm: Float32Array): boolean | Promise<boolean>
  result(): string | Promise<string>
  partial(): string | Promise<string>
  /** The end of the phrase: its words. Ready for the next after. */
  finish(): string | Promise<string>
  configure(cfg: WorkerConfig): void
}

export type MakeRecogniser = (files: Map<string, ArrayBuffer>, model: CatalogModel, cfg: WorkerConfig) => Promise<Recogniser>

function post(m: FromCaptionWorker) {
  self.postMessage(m)
}

export function run(make: MakeRecogniser) {
  let model: CatalogModel | null = null
  let base = ''
  let cfg: WorkerConfig
  let rec: Recogniser | null = null
  let allowDownload: (() => void) | null = null
  let downloadAsked = false

  const status = (s: ModelStatus) => post({ type: 'model', status: s })

  async function load() {
    const m = model!
    status({ phase: 'checking', bytes: 0, total: 0 })
    const have = await cachedFiles(base, m)
    const missing = m.files.filter(([path]) => !have.has(path))
    if (missing.length) {
      const res = await fetch(new URL(`${m.id}/manifest.json`, base), { cache: 'no-store' }).catch(() => null)
      const manifest = res?.ok ? checkManifest(m, await res.json().catch(() => null)) : null
      if (!manifest) throw new Error(res && !res.ok ? `the ${m.title} model isn't on this server` : `couldn't reach the ${m.title} model`)
      const todo = manifest.files.filter(f => missing.some(([p]) => p === f.path))
      const total = downloadBytes({ ...manifest, files: todo })
      status({ phase: 'needed', bytes: 0, total })
      if (!downloadAsked) await new Promise<void>(resolve => (allowDownload = resolve))
      let done = 0
      for (const f of todo) {
        const before = done
        await downloadFile(base, m, f, got => {
          done = before + got
          status({ phase: 'downloading', bytes: done, total })
        })
        done = before + f.parts.reduce((n, p) => n + p.size, 0)
      }
    }
    status({ phase: 'loading', bytes: 0, total: 0 })
    const files = new Map<string, ArrayBuffer>()
    for (const [path, sha] of m.files) {
      const buf = await readCached(base, m, path, sha)
      if (!buf) throw new Error(`${path} went missing from the cache`)
      files.set(path, buf)
    }
    rec = await make(files, m, cfg)
    status({ phase: 'ready', bytes: 0, total: 0 })
  }

  // ---- the audio ----------------------------------------------------------------

  type Item = { pcm: Float32Array } | { end: true }
  const queue: Item[] = []
  const decimator = new Decimator()
  let scratch = new Float32Array(CAPTION_FRAME)
  let nextTs = -1
  let lost = 0
  let busy = false

  /** A frame from the worklet: decimated now (cheap), recognised in order. */
  function take(ts: number, pcm: Float32Array | null) {
    if (!pcm) {
      queue.push({ end: true })
      nextTs = -1
      decimator.reset()
    } else {
      if (nextTs >= 0 && ts > nextTs) lost += ts - nextTs
      nextTs = ts + pcm.length
      if (scratch.length < pcm.length) scratch = new Float32Array(pcm.length)
      const n = decimator.push(pcm, 0, pcm.length, scratch)
      queue.push({ pcm: scratch.slice(0, n) })
    }
    if (!busy) void work()
  }

  // ---- recognising ----------------------------------------------------------------

  let u = 0
  let partialText = ''
  let partialAt = 0
  let sinceReread = 0
  let busyMs = 0
  let audioMs = 0
  let statsAt = performance.now()

  async function work() {
    busy = true
    try {
      while (queue.length && rec) {
        const item = queue.shift()!
        const t0 = performance.now()
        if ('end' in item) await finish()
        else await feed(item.pcm)
        busyMs += performance.now() - t0
      }
    } finally {
      busy = false
    }
    const now = performance.now()
    if (now - statsAt > 2000) {
      post({ type: 'stats', rtf: audioMs > 0 ? busyMs / audioMs : null, lost })
      statsAt = now
      busyMs = 0
      audioMs = 0
    }
  }

  /** Behind: more than half a second of speech still waiting. */
  function behind(): boolean {
    let n = 0
    for (const q of queue) if ('pcm' in q) n += q.pcm.length
    return n > CAPTION_RATE / 2
  }

  async function feed(pcm: Float32Array) {
    const r = rec!
    audioMs += (pcm.length * 1000) / CAPTION_RATE
    if (await r.accept(pcm)) {
      say(await r.result(), true)
      return
    }
    if (!r.streaming && r.held >= cfg.maxPhraseSec * CAPTION_RATE) {
      // A long phrase: finish it here, and the next one picks up where it stops.
      say(await r.finish(), true)
      sinceReread = 0
      return
    }
    if (!cfg.partials) return
    if (r.streaming) {
      const now = performance.now()
      if (now - partialAt < 1000 / cfg.partialsPerSec) return
      partialAt = now
      say(await r.partial(), false)
    } else {
      sinceReread += pcm.length
      if (sinceReread < (cfg.rereadMs * CAPTION_RATE) / 1000 || behind()) return
      sinceReread = 0
      say(await r.partial(), false)
    }
  }

  async function finish() {
    sinceReread = 0
    say(await rec!.finish(), true)
  }

  function say(text: string, final: boolean) {
    text = text.trim()
    if (!final) {
      if (!text || text === partialText) return
      partialText = text
      post({ type: 'text', u, text, final: false })
      return
    }
    // A finished phrase, or nothing (which clears what was showing of it).
    if (text || partialText) post({ type: 'text', u, text, final: true })
    if (text || partialText) u++
    partialText = ''
  }

  // ---- the page ------------------------------------------------------------------------

  async function pumpRing(ring: FrameRing) {
    type AtomicsWait = { waitAsync?(a: Int32Array, i: number, v: number): { async: false; value: string } | { async: true; value: Promise<string> } }
    const waitAsync = (Atomics as unknown as AtomicsWait).waitAsync
    for (;;) {
      const seen = ring.written
      ring.drain((ts, pcm) => take(ts, pcm.length ? pcm : null))
      if (waitAsync) {
        const w = waitAsync(ring.ctrl, 0, seen)
        if (w.async) await w.value
      } else await new Promise(r => setTimeout(r, 20))
    }
  }

  self.onmessage = (e: MessageEvent<ToCaptionWorker>) => {
    const m = e.data
    switch (m.type) {
      case 'init':
        model = modelOf(m.model)
        base = m.base
        cfg = m.cfg
        if (m.port) m.port.onmessage = (ev: MessageEvent<CaptionTapFrame>) => take(nextTs < 0 ? 0 : nextTs, 'pcm' in ev.data ? ev.data.pcm : null)
        if (m.ring) void pumpRing(FrameRing.from(m.ring, CAPTION_SLOTS, CAPTION_FRAME))
        if (!model) status({ phase: 'error', bytes: 0, total: 0, error: `no model ${m.model}` })
        else
          load().catch(err => {
            console.warn('captions:', err)
            status({ phase: 'error', bytes: 0, total: 0, error: err instanceof Error ? err.message : String(err) })
          })
        return
      case 'download':
        downloadAsked = true
        allowDownload?.()
        return
      case 'config':
        cfg = m.cfg
        rec?.configure(cfg)
        return
    }
  }
}
