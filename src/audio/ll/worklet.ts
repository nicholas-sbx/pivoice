/**
 * The low-latency engine's audio-thread half: one module, two processors.
 *
 *   pv-capture   mic → fixed-size frames, stamped with this context's
 *                sample clock, posted straight to the engine's worker
 *   pv-playback  decoded frames in (straight from the worker), a steady
 *                stream out through the JitterBuffer, one node per person
 *
 * Both talk to the worker directly, so the page's main thread is never in
 * the audio path: through shared memory (FrameRing) when the page is
 * cross-origin isolated, over MessagePorts when it isn't.
 *
 * Runs in the AudioWorkletGlobalScope, so only what's declared below exists.
 */
import { JitterBuffer, type JitterConfig } from './jitter'
import { FrameRing, RING_MAX_FRAME, RING_SLOTS } from './ring'

declare const sampleRate: number
declare const currentFrame: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
}
declare function registerProcessor(name: string, ctor: unknown): void

interface Options<T> {
  processorOptions: T
}

export type CaptureMessage = { frame?: number; active?: boolean; out?: MessagePort }
export type CaptureFrame = { ts: number; pcm: Float32Array<ArrayBuffer> }

class Capture extends AudioWorkletProcessor {
  private frame = 240
  private buf = new Float32Array(240)
  private fill = 0
  private start = 0
  private active = false
  private out: MessagePort | null = null
  private ring: FrameRing | null = null

  constructor(options: Options<{ frame: number; active: boolean; ring?: SharedArrayBuffer }>) {
    super()
    this.setFrame(options.processorOptions.frame)
    this.active = options.processorOptions.active
    const sab = options.processorOptions.ring
    if (sab) this.ring = FrameRing.from(sab, RING_SLOTS, RING_MAX_FRAME)
    this.port.onmessage = (e: MessageEvent<CaptureMessage>) => {
      if (e.data.out) this.out = e.data.out
      if (e.data.frame) this.setFrame(e.data.frame)
      if (typeof e.data.active === 'boolean') {
        this.active = e.data.active
        this.fill = 0
      }
    }
  }

  private setFrame(n: number) {
    if (n === this.frame) return
    this.frame = n
    this.buf = new Float32Array(n)
    this.fill = 0
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.active || (!this.out && !this.ring)) return true
    const input = inputs[0]?.[0]
    const n = input?.length ?? 128
    for (let i = 0; i < n; i++) {
      if (this.fill === 0) this.start = currentFrame + i
      this.buf[this.fill++] = input ? input[i] : 0
      if (this.fill === this.frame) {
        if (this.ring) {
          this.ring.push(this.start, this.buf)
          this.ring.notify()
        } else if (this.out) {
          const pcm = this.buf.slice()
          const msg: CaptureFrame = { ts: this.start, pcm }
          this.out.postMessage(msg, [pcm.buffer])
        }
        this.fill = 0
      }
    }
    return true
  }
}

export type PlaybackMessage =
  | { type: 'frame'; ts: number; pcm: Float32Array }
  | { type: 'config'; jitter: Partial<JitterConfig> }
  /** Where decoded frames will come from: the worker's end of a channel. */
  | { type: 'port'; port: MessagePort }

class Playback extends AudioWorkletProcessor {
  private jb: JitterBuffer
  private lastStats = 0
  private ring: FrameRing | null = null

  constructor(options: Options<{ jitter: Omit<JitterConfig, 'sampleRate'>; ring?: SharedArrayBuffer }>) {
    super()
    this.jb = new JitterBuffer({ ...options.processorOptions.jitter, sampleRate })
    const sab = options.processorOptions.ring
    if (sab) this.ring = FrameRing.from(sab, RING_SLOTS, RING_MAX_FRAME)
    const onMessage = (e: MessageEvent<PlaybackMessage>) => {
      const m = e.data
      if (m.type === 'frame') this.jb.push(m.ts, m.pcm, currentFrame)
      else if (m.type === 'config') this.jb.configure(m.jitter)
      else if (m.type === 'port') m.port.onmessage = onMessage
    }
    this.port.onmessage = onMessage
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0][0]
    // Whatever the worker has written since the last block is here now.
    this.ring?.drain((ts, pcm) => this.jb.push(ts, pcm.slice(), currentFrame))
    this.jb.pull(out, currentFrame)
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out)
    if (currentFrame - this.lastStats >= sampleRate / 2) {
      this.lastStats = currentFrame
      this.port.postMessage({ type: 'stats', ...this.jb.stats() })
    }
    return true
  }
}

registerProcessor('pv-capture', Capture)
registerProcessor('pv-playback', Playback)
