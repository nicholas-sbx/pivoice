/**
 * The captions' audio-thread half: one processor, pv-caption, that decides
 * when the recogniser hears you and hands it those samples, nothing else.
 *
 *   input 0: the raw mic (what's recognised)
 *   input 1: the mic as the call has it (what the ring goes by; the same
 *            node as input 0 when the browser's processing is all off)
 *
 * It runs CaptionGate (gate.ts) on the ring's own rule over a 1024-sample
 * window, like the page's analyser, and sends what the gate lets through to
 * the caption worker in 20 ms frames: through shared memory when the page
 * is cross-origin isolated (a FrameRing, an empty frame for "end of
 * segment"), over a MessagePort otherwise.
 *
 * What it costs: switched off (captions off, you muted, nobody to send to,
 * the model not ready) it returns at once each block; on, between segments,
 * it copies each block into the pre-roll and measures the level, and that's
 * all: nothing reaches the worker, so the recogniser does nothing. The
 * module isn't even loaded until captions start.
 *
 * Runs in the AudioWorkletGlobalScope, so only what's declared below exists.
 */
import { FrameRing } from '../audio/ll/ring'
import { CaptionGate, LevelMeter, type GateSink } from './gate'
import { CAPTION_FRAME, CAPTION_SLOTS, type CaptionTapFrame, type CaptionTapMessage, type CaptionTapOptions } from './tap'

declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
}
declare function registerProcessor(name: string, ctor: unknown): void

/** The ring's window, as the page's analyser (AnalyserNode.fftSize 1024). */
const LEVEL_WINDOW = 1024

class CaptionTap extends AudioWorkletProcessor implements GateSink {
  private gate: CaptionGate
  private meter = new LevelMeter(128, LEVEL_WINDOW)
  private on = false
  private ring: FrameRing | null = null
  /** Where frames go when there's no shared memory. */
  private out: MessagePort | null = null
  private frame = new Float32Array(CAPTION_FRAME)
  private fill = 0
  /** Samples sent since this started: the frames' ts, so the worker can tell when some were lost. */
  private sent = 0

  constructor(options: { processorOptions: CaptionTapOptions }) {
    super()
    const o = options.processorOptions
    this.gate = new CaptionGate({ sampleRate, preMs: o.preMs, postMs: o.postMs }, o.maxPreMs)
    if (o.ring) this.ring = FrameRing.from(o.ring, CAPTION_SLOTS, CAPTION_FRAME)
    this.port.onmessage = (e: MessageEvent<CaptionTapMessage>) => {
      const m = e.data
      if (m.port) this.out = m.port
      if (m.preMs !== undefined || m.postMs !== undefined) this.gate.configure({ preMs: m.preMs, postMs: m.postMs })
      if (typeof m.on === 'boolean' && m.on !== this.on) {
        this.on = m.on
        // Off: whatever's open ends now, and nothing from before carries over.
        if (!m.on) this.gate.reset(this)
      }
    }
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.on) return true
    const raw = inputs[0]?.[0]
    if (!raw) return true
    const ring = inputs[1]?.[0] ?? raw
    this.gate.push(raw, this.meter.push(ring, ring.length), this)
    return true
  }

  // ---- GateSink: what the gate lets through, in frames, to the worker ----

  start() {}

  audio(buf: Float32Array, from: number, to: number) {
    for (let i = from; i < to; i++) {
      this.frame[this.fill++] = buf[i]
      if (this.fill === CAPTION_FRAME) this.flush()
    }
  }

  end() {
    this.flush()
    if (this.ring) {
      this.ring.push(this.sent, this.frame, 0)
      this.ring.notify()
    } else this.out?.postMessage({ end: true } satisfies CaptionTapFrame)
  }

  private flush() {
    if (!this.fill) return
    if (this.ring) {
      this.ring.push(this.sent, this.frame, this.fill)
      this.ring.notify()
    } else if (this.out) {
      const pcm = this.frame.slice(0, this.fill)
      this.out.postMessage({ pcm } satisfies CaptionTapFrame, [pcm.buffer])
    }
    this.sent += this.fill
    this.fill = 0
  }
}

registerProcessor('pv-caption', CaptionTap)
