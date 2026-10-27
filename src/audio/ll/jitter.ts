/**
 * The low-latency engine's jitter buffer: decoded audio in, a steady stream
 * of samples out, as little delay as the network's jitter allows.
 *
 * Everything is in samples. The sender stamps each frame with its own
 * sample clock (`ts`); we note when each frame arrives on ours. Over the
 * last few seconds:
 *
 *   base   = the smallest (arrival − ts): the best this path ever does
 *   jitter = a high percentile (99th by default) of how much later than that frames arrive
 *   target = jitter × multiplier + margin, clamped to [min, max]
 *
 * and the sample that should be playing at the start of a block is
 * `now − base − target − block`: the whole block has to be on hand when it
 * starts, since frames can only land between blocks.
 * A frame arriving later than that is too late and is dropped.
 *
 * - **Steering.** If playback drifts from where it should be, the speed
 *   changes by up to ±stretch% until it's back. Pitch moves by the same
 *   amount, which is inaudible at 2%. Far too deep (more than the max
 *   buffer behind) jumps straight there.
 * - **Gaps** (a lost packet nothing recovered) are concealed by fading out a
 *   repeat of the last frame over `conceal` samples, then silence.
 * - **Underruns** (nothing left: the talker went quiet, DTX, or the network
 *   stalled) do the same and then go idle. The next frame to arrive starts
 *   a fresh talkspurt exactly `target` behind, which is where most
 *   adaptation happens for free.
 */

export interface JitterConfig {
  sampleRate: number
  minMs: number
  maxMs: number
  marginMs: number
  multiplier: number
  /** Fraction, e.g. 0.02 for ±2%. */
  stretch: number
  concealMs: number
  /** Which percentile of lateness is "the jitter" (100 = the worst in the window). */
  percentile: number
  windowSec: number
}

export interface JitterStats {
  /** What the buffer is aiming for, ms. */
  targetMs: number
  /** How long the samples played since the last read waited after arriving, on average, ms. */
  bufferMs: number | null
  /** 95th percentile jitter over the window, ms. */
  jitterMs: number
  late: number
  /** Share of played audio that was papered over because a frame was lost (not the fades at the ends of sentences). */
  concealedPct: number
  underruns: number
  /** The last real sample played: its sender timestamp, and our sample clock when it played. For measuring the whole path. */
  playTs: number | null
  atFrame: number
}

interface Stored {
  start: number
  pcm: Float32Array
  arrival: number
}

const IDLE_AFTER_MS = 80

export class JitterBuffer {
  private frames: Stored[] = []
  private arrivals: { at: number; off: number }[] = []
  private base: number | null = null
  private jitter = 0
  private estimatedAt = -Infinity
  /** Sender-clock position being played, or null while idle. */
  private pos: number | null = null
  private cursor: Stored | null = null
  private lastGood: Stored | null = null
  private lastGoodEnd = 0
  private emptySince: number | null = null
  // Counters since the last stats() call.
  private late = 0
  private concealed = 0
  private played = 0
  private underruns = 0
  private waitSum = 0
  private waitCount = 0
  private lastPlayed: { ts: number; at: number } | null = null

  constructor(private cfg: JitterConfig) {}

  configure(cfg: Partial<JitterConfig>) {
    this.cfg = { ...this.cfg, ...cfg }
  }

  private ms(n: number): number {
    return (n * 1000) / this.cfg.sampleRate
  }
  private samples(ms: number): number {
    return (ms * this.cfg.sampleRate) / 1000
  }

  /** A decoded frame: `ts` on the sender's clock, `arrival` on ours. */
  push(ts: number, pcm: Float32Array, arrival: number) {
    const off = arrival - ts
    this.arrivals.push({ at: arrival, off })
    if (this.base === null || off < this.base) this.base = off
    if (this.pos !== null && ts + pcm.length <= this.pos) {
      this.late++
      return
    }
    // Keep them sorted by start; nearly always this is an append.
    let i = this.frames.length
    while (i > 0 && this.frames[i - 1].start > ts) i--
    if (i > 0 && this.frames[i - 1].start === ts) return
    this.frames.splice(i, 0, { start: ts, pcm, arrival })
  }

  private estimate(now: number) {
    if (now - this.estimatedAt < this.samples(50)) return
    this.estimatedAt = now
    const cutoff = now - this.cfg.windowSec * this.cfg.sampleRate
    let drop = 0
    while (drop < this.arrivals.length - 1 && this.arrivals[drop].at < cutoff) drop++
    if (drop) this.arrivals.splice(0, drop)
    if (!this.arrivals.length) return
    let base = Infinity
    for (const a of this.arrivals) base = Math.min(base, a.off)
    const late = this.arrivals.map(a => a.off - base).sort((x, y) => x - y)
    this.base = base
    this.jitter = late[Math.min(late.length - 1, Math.floor((late.length * this.cfg.percentile) / 100))]
  }

  targetSamples(): number {
    const { minMs, maxMs, marginMs, multiplier } = this.cfg
    const ms = Math.min(maxMs, Math.max(minMs, this.ms(this.jitter) * multiplier + marginMs))
    return this.samples(ms)
  }

  /** Fills `out` with the block starting at our sample `now`. */
  pull(out: Float32Array, now: number) {
    this.estimate(now)
    const n = out.length
    if (this.base === null) {
      out.fill(0)
      return
    }
    const desired = now - this.base - this.targetSamples() - n

    if (this.pos === null) {
      // Idle: start when the earliest frame is due.
      this.dropOlderThan(desired - this.samples(this.cfg.maxMs))
      const first = this.frames[0]
      if (!first || first.start > desired) {
        out.fill(0)
        return
      }
      const last = this.frames[this.frames.length - 1]
      this.pos = Math.min(Math.max(first.start, desired), last.start)
      this.cursor = null
      this.emptySince = null
    }

    let err = this.pos - desired
    if (err < -this.samples(this.cfg.maxMs)) {
      // Far too deep (a stall let a backlog build): jump.
      this.pos = desired
      err = 0
    }
    const k = this.samples(20)
    const rate = 1 - Math.max(-1, Math.min(1, err / k)) * this.cfg.stretch

    for (let i = 0; i < n; i++) {
      if (this.pos === null) {
        out[i] = 0
        continue
      }
      const p = this.pos
      const ip = Math.floor(p)
      const frac = p - ip
      const a = this.sample(ip, now + i)
      const b = frac > 0 ? this.sample(ip + 1, now + i) : a
      out[i] = a + (b - a) * frac
      if (this.pos !== null) this.pos += rate
    }
    if (this.pos !== null) this.dropOlderThan(this.pos - this.samples(5))
  }

  private find(ip: number): Stored | null {
    const c = this.cursor
    if (c && ip >= c.start && ip < c.start + c.pcm.length) return c
    // Usually the very next frame.
    for (const f of this.frames) {
      if (ip >= f.start && ip < f.start + f.pcm.length) return f
      if (f.start > ip) break
    }
    return null
  }

  private sample(ip: number, now: number): number {
    const f = this.find(ip)
    if (f) {
      if (f !== this.cursor) {
        this.cursor = f
        this.waitSum += now - f.arrival
        this.waitCount++
      }
      this.lastGood = f
      this.lastGoodEnd = f.start + f.pcm.length
      this.emptySince = null
      this.played++
      this.lastPlayed = { ts: ip, at: now }
      return f.pcm[ip - f.start]
    }
    // Nothing here: conceal by fading out a repeat of the last good frame.
    const since = ip - this.lastGoodEnd
    const conceal = this.samples(this.cfg.concealMs)
    let v = 0
    const ahead = this.frames.length > 0 && this.frames[this.frames.length - 1].start > ip
    if (this.lastGood && since >= 0 && since < conceal) {
      const g = this.lastGood
      v = g.pcm[(((ip - g.start) % g.pcm.length) + g.pcm.length) % g.pcm.length] * (1 - since / conceal)
      // Only a hole with audio after it is a loss; running out is just the end of a sentence.
      if (ahead) this.concealed++
    }
    if (!ahead) {
      // Underrun. Go idle if it lasts, so the next talkspurt starts fresh.
      if (this.emptySince === null) {
        this.emptySince = now
        this.underruns++
      } else if (now - this.emptySince > this.samples(IDLE_AFTER_MS)) {
        this.pos = null
        this.cursor = null
      }
    }
    return v
  }

  private dropOlderThan(t: number) {
    let i = 0
    while (i < this.frames.length && this.frames[i].start + this.frames[i].pcm.length < t) i++
    if (i) this.frames.splice(0, i)
  }

  stats(): JitterStats {
    const total = this.played + this.concealed
    const s: JitterStats = {
      targetMs: this.ms(this.targetSamples()),
      bufferMs: this.waitCount ? this.ms(this.waitSum / this.waitCount) : null,
      jitterMs: this.ms(this.jitter),
      late: this.late,
      concealedPct: total ? (this.concealed / total) * 100 : 0,
      underruns: this.underruns,
      playTs: this.lastPlayed?.ts ?? null,
      atFrame: this.lastPlayed?.at ?? 0
    }
    this.late = this.concealed = this.played = this.underruns = this.waitSum = this.waitCount = 0
    return s
  }
}
