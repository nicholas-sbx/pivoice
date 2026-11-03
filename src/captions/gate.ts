import { SPEAKING_HOLD_MS, SPEAKING_RMS } from '../audio/activity'

/**
 * What the recogniser is let hear: you, while your ring is lit, and a
 * little either side. The same rule in a browser (run on the audio thread,
 * worklet.ts) and in the app (native/internal/captions/gate.go, tested
 * against the same cases).
 *
 * Fed one block at a time: the raw mic (what's recognised) and the level
 * the ring goes by (the mic after processing, so whatever the noise
 * suppression takes out doesn't light it). The ring rule is the page's
 * (audio/activity.ts): louder than SPEAKING_RMS, and lit for
 * SPEAKING_HOLD_MS after the last loud block.
 *
 *   ring out:  the last `preMs` of raw audio is kept, nothing goes anywhere
 *   ring lit:  start, then those `preMs` straight away (the recogniser takes
 *              them faster than real time), then every block as it comes
 *   ring out again: `postMs` more, then end (the recogniser finishes the phrase)
 *
 * A ring that lights again during the post-roll carries on the same
 * segment. After an end the kept audio starts again from nothing, so no
 * sample is sent twice.
 *
 * Nothing here allocates once it's made: the pre-roll is one buffer, as
 * long as it can ever be, and audio goes out as (buffer, from, to).
 */

export interface GateSink {
  start(): void
  /** Samples [from, to) of buf, which is only lent: copy what you keep. */
  audio(buf: Float32Array, from: number, to: number): void
  end(): void
}

export interface GateConfig {
  sampleRate: number
  /** Kept from before the ring lights, ms. */
  preMs: number
  /** Kept going after it goes out, ms. */
  postMs: number
  /** The ring's rule (defaults: the page's). */
  threshold?: number
  holdMs?: number
}

export class CaptionGate {
  private pre: Float32Array
  /** Samples written to `pre` since it last started again (the newest is at (written - 1) % length). */
  private written = 0
  /** Samples seen. */
  private now = 0
  /** When the last loud block ended (samples). */
  private loudAt = -Infinity
  private open = false
  /** Post-roll left once the ring's out, samples. */
  private tail = 0
  private cfg: Required<GateConfig>

  /** `maxPreMs`: the longest pre-roll it will ever be asked for (the buffer is that big). */
  constructor(cfg: GateConfig, maxPreMs: number) {
    this.cfg = { threshold: SPEAKING_RMS, holdMs: SPEAKING_HOLD_MS, ...cfg }
    this.pre = new Float32Array(Math.max(1, Math.ceil((maxPreMs * cfg.sampleRate) / 1000)))
  }

  configure(cfg: Partial<GateConfig>) {
    this.cfg = { ...this.cfg, ...cfg }
  }

  get isOpen(): boolean {
    return this.open
  }

  private samples(ms: number): number {
    return Math.round((ms * this.cfg.sampleRate) / 1000)
  }

  /** One block of raw audio, and the level that decides the ring for it. */
  push(raw: Float32Array, level: number, sink: GateSink) {
    const n = raw.length
    const end = this.now + n
    const loud = level > this.cfg.threshold
    if (loud) this.loudAt = end
    const lit = loud || end - this.loudAt < this.samples(this.cfg.holdMs)
    if (!this.open) {
      if (lit) {
        this.open = true
        this.tail = this.samples(this.cfg.postMs)
        sink.start()
        this.flushPre(sink)
        sink.audio(raw, 0, n)
      } else this.keep(raw)
    } else {
      sink.audio(raw, 0, n)
      if (lit) this.tail = this.samples(this.cfg.postMs)
      else {
        this.tail -= n
        if (this.tail <= 0) this.close(sink)
      }
    }
    this.now = end
  }

  /** Stop listening (muted, captions off): ends an open segment and forgets the pre-roll. */
  reset(sink: GateSink | null) {
    if (this.open && sink) sink.end()
    this.open = false
    this.written = 0
    this.loudAt = -Infinity
  }

  private close(sink: GateSink) {
    this.open = false
    this.written = 0
    sink.end()
  }

  private keep(raw: Float32Array) {
    const len = this.pre.length
    let w = this.written % len
    for (let i = 0; i < raw.length; i++) {
      this.pre[w] = raw[i]
      w = w + 1 === len ? 0 : w + 1
    }
    this.written += raw.length
  }

  /** The newest `preMs` of what was kept, oldest first, in at most two pieces. */
  private flushPre(sink: GateSink) {
    const len = this.pre.length
    const n = Math.min(this.written, len, this.samples(this.cfg.preMs))
    if (n <= 0) return
    const endAt = this.written % len
    const start = (endAt - n + len) % len
    if (start < endAt) sink.audio(this.pre, start, endAt)
    else {
      sink.audio(this.pre, start, len)
      if (endAt > 0) sink.audio(this.pre, 0, endAt)
    }
  }
}

/**
 * The level of the last `window` samples (RMS), a block at a time: what the
 * page's analyser measures for the ring (1024 samples), here without
 * waiting for it to be asked.
 */
export class LevelMeter {
  private sums: Float64Array
  private i = 0
  private total = 0
  private count = 0

  constructor(
    private block: number,
    window: number
  ) {
    this.sums = new Float64Array(Math.max(1, Math.round(window / block)))
  }

  /** A block's samples (any length up to the block size); returns the RMS over the window. */
  push(x: Float32Array | undefined, n: number): number {
    let s = 0
    if (x) for (let k = 0; k < n; k++) s += x[k] * x[k]
    this.total += s - this.sums[this.i]
    this.sums[this.i] = s
    this.i = (this.i + 1) % this.sums.length
    this.count = Math.min(this.sums.length, this.count + 1)
    return Math.sqrt(Math.max(0, this.total) / (this.count * this.block))
  }
}
