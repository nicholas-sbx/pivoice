/**
 * 48 kHz down to the recogniser's 16 kHz: a low-pass, then every third
 * sample. The same filter as the app's (native/internal/captions/decimate.go).
 *
 * 95 taps of a Kaiser-windowed sinc (β 7) cutting at 7.3 kHz: flat to
 * 6 kHz, and everything that would fold back into the model's band (it
 * listens up to 7.6 kHz, conf/mfcc.conf) is at least 60 dB down. About
 * 1.5 million multiply-adds a second of speech, on the worker.
 */

export const DECIMATE_TAPS = 95
const CUTOFF_HZ = 7300
const BETA = 7
const IN_RATE = 48_000

/** Modified Bessel function of the first kind, order 0 (for the Kaiser window). */
function i0(x: number): number {
  let sum = 1
  let term = 1
  const q = (x / 2) * (x / 2)
  for (let k = 1; k < 50; k++) {
    term *= q / (k * k)
    sum += term
    if (term < sum * 1e-12) break
  }
  return sum
}

/** The filter, unity gain at DC. */
export function decimateTaps(): Float64Array {
  const n = DECIMATE_TAPS
  const m = (n - 1) / 2
  const fc = CUTOFF_HZ / IN_RATE
  const h = new Float64Array(n)
  let sum = 0
  for (let k = 0; k < n; k++) {
    const t = k - m
    const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t)
    const r = t / m
    h[k] = sinc * (i0(BETA * Math.sqrt(Math.max(0, 1 - r * r))) / i0(BETA))
    sum += h[k]
  }
  for (let k = 0; k < n; k++) h[k] /= sum
  return h
}

const TAPS = decimateTaps()

export class Decimator {
  /** The last DECIMATE_TAPS inputs, twice over so a window is always one straight run. */
  private line = new Float64Array(2 * DECIMATE_TAPS)
  private pos = 0
  private phase = 0

  /** Takes in[from, to) at 48 kHz, writes the 16 kHz samples to out from `at`; returns how many it wrote. */
  push(input: Float32Array, from: number, to: number, out: Float32Array, at = 0): number {
    const n = DECIMATE_TAPS
    let w = at
    for (let i = from; i < to; i++) {
      const v = input[i]
      this.line[this.pos] = v
      this.line[this.pos + n] = v
      this.pos = this.pos + 1 === n ? 0 : this.pos + 1
      if (++this.phase === 3) {
        this.phase = 0
        // line[pos .. pos+n) is oldest to newest.
        let acc = 0
        for (let k = 0; k < n; k++) acc += TAPS[n - 1 - k] * this.line[this.pos + k]
        out[w++] = acc
      }
    }
    return w - at
  }

  /** Forget what came before (a new segment starts from silence). */
  reset() {
    this.line.fill(0)
    this.pos = 0
    this.phase = 0
  }
}
