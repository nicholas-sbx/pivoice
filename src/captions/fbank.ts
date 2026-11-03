/**
 * Log-mel features as NVIDIA NeMo models (Parakeet) are fed them, computed
 * the way sherpa-onnx computes them (its NeMo CTC settings over
 * kaldi-native-fbank 1.22.3, in "librosa" mode), so the browser hears the
 * same numbers the app's native recogniser does. tests/fbank.test.ts holds
 * this to features from kaldi-native-fbank itself.
 *
 *   16 kHz, 25 ms frames every 10 ms, centred (snip_edges false: frames
 *   reach past both ends, which are reflected), pre-emphasis 0.97, a
 *   periodic Hann window, a 512-point FFT, power spectrum, 80 triangular
 *   Slaney mel bins over 0–8 kHz with Slaney area normalisation,
 *   log(max(e, FLT_EPSILON)), then each bin normalised over the phrase
 *   (NeMo's per_feature: zero mean, unit standard deviation + 1e-5).
 */

const RATE = 16_000
const SHIFT = 160
const LENGTH = 400
const FFT = 512
const BINS = FFT / 2 + 1
const PREEMPH = 0.97
const FLT_EPSILON = 1.1920928955078125e-7

function melSlaney(hz: number): number {
  return hz <= 1000 ? (hz * 3) / 200 : 15 + 14.545078505785561 * Math.log(hz / 1000)
}
function hzSlaney(mel: number): number {
  return mel <= 15 ? (200 / 3) * mel : 1000 * Math.exp((mel - 15) * 0.06875177742094911)
}

/** Each mel bin's weights over the power spectrum: first FFT bin, then weights. */
export function melBanks(numBins: number): { first: number; w: Float64Array }[] {
  const lowMel = melSlaney(0)
  const highMel = melSlaney(RATE / 2)
  const delta = (highMel - lowMel) / (numBins + 1)
  const width = RATE / FFT
  const banks: { first: number; w: Float64Array }[] = []
  for (let b = 0; b < numBins; b++) {
    const left = hzSlaney(lowMel + b * delta)
    const centre = hzSlaney(lowMel + (b + 1) * delta)
    const right = hzSlaney(lowMel + (b + 2) * delta)
    // The FFT bins strictly inside the triangle: one run of them.
    const w: number[] = []
    let first = -1
    for (let i = 0; i < BINS; i++) {
      const hz = width * i
      if (hz > left && hz < right) {
        if (first < 0) first = i
        w.push((hz <= centre ? (hz - left) / (centre - left) : (right - hz) / (right - centre)) * (2 / (right - left)))
      }
    }
    banks.push({ first, w: Float64Array.from(w) })
  }
  return banks
}

/** An in-place radix-2 FFT of size FFT, twiddles made once. */
class Fft {
  private cos = new Float64Array(FFT / 2)
  private sin = new Float64Array(FFT / 2)
  private rev = new Uint16Array(FFT)

  constructor() {
    for (let i = 0; i < FFT / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / FFT)
      this.sin[i] = -Math.sin((2 * Math.PI * i) / FFT)
    }
    const bits = Math.log2(FFT)
    for (let i = 0; i < FFT; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.rev[i] = r
    }
  }

  run(re: Float64Array, im: Float64Array) {
    for (let i = 0; i < FFT; i++) {
      const j = this.rev[i]
      if (j > i) {
        let t = re[i]
        re[i] = re[j]
        re[j] = t
        t = im[i]
        im[i] = im[j]
        im[j] = t
      }
    }
    for (let size = 2; size <= FFT; size *= 2) {
      const half = size / 2
      const step = FFT / size
      for (let start = 0; start < FFT; start += size) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step]
          const s = this.sin[k * step]
          const a = start + k
          const b = a + half
          const tr = re[b] * c - im[b] * s
          const ti = re[b] * s + im[b] * c
          re[b] = re[a] - tr
          im[b] = im[a] - ti
          re[a] += tr
          im[a] += ti
        }
      }
    }
  }
}

export class NemoFeatures {
  private banks: { first: number; w: Float64Array }[]
  private window = new Float64Array(LENGTH)
  private fft = new Fft()
  private re = new Float64Array(FFT)
  private im = new Float64Array(FFT)
  private power = new Float64Array(BINS)

  constructor(readonly numBins = 80) {
    this.banks = melBanks(numBins)
    // Periodic Hann, as torch.hann_window.
    for (let i = 0; i < LENGTH; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / LENGTH)
  }

  static frames(samples: number): number {
    return Math.floor((samples + SHIFT / 2) / SHIFT)
  }

  /** Frame f's first sample (it can be before the start: those are reflected). */
  static firstSample(f: number): number {
    return SHIFT * f + SHIFT / 2 - LENGTH / 2
  }

  /**
   * One frame's log-mel bins from `re` (its LENGTH samples, already cut
   * out), written to out[at + b * stride].
   */
  private logMel(out: Float32Array, at: number, stride: number) {
    const { re, im, power, window } = this
    for (let s = LENGTH - 1; s > 0; s--) re[s] -= PREEMPH * re[s - 1]
    re[0] -= PREEMPH * re[0]
    for (let s = 0; s < LENGTH; s++) re[s] *= window[s]
    re.fill(0, LENGTH)
    im.fill(0)
    this.fft.run(re, im)
    for (let k = 0; k < BINS; k++) power[k] = re[k] * re[k] + im[k] * im[k]
    for (let b = 0; b < this.numBins; b++) {
      const { first, w } = this.banks[b]
      let e = 0
      for (let k = 0; k < w.length; k++) e += w[k] * power[first + k]
      out[at + b * stride] = Math.log(Math.max(e, FLT_EPSILON))
    }
  }

  /**
   * Frame f of a signal that may still be going: `wave` holds its samples
   * from `offset` on, and every one the frame needs is there, except any
   * before the very start, which are reflected (as when the signal is
   * whole). Bins to out[at + b * stride].
   */
  frameOf(wave: Float32Array, offset: number, f: number, out: Float32Array, at: number, stride: number) {
    const start = NemoFeatures.firstSample(f)
    const re = this.re
    for (let s = 0; s < LENGTH; s++) {
      const i = start + s
      re[s] = wave[(i < 0 ? -i - 1 : i) - offset]
    }
    this.logMel(out, at, stride)
  }

  /**
   * Features for a whole phrase, samples in [-1, 1] at 16 kHz: bins × frames,
   * bin-major (the model's [1, bins, frames]), normalised.
   */
  compute(wave: Float32Array, normalise = true): { data: Float32Array; frames: number } {
    const n = wave.length
    const frames = n === 0 ? 0 : NemoFeatures.frames(n)
    const bins = this.numBins
    const out = new Float32Array(bins * frames)
    const re = this.re
    for (let f = 0; f < frames; f++) {
      const start = NemoFeatures.firstSample(f)
      for (let s = 0; s < LENGTH; s++) {
        let i = start + s
        while (i < 0 || i >= n) i = i < 0 ? -i - 1 : 2 * n - 1 - i
        re[s] = wave[i]
      }
      this.logMel(out, f, frames)
    }
    // Per feature: each bin to zero mean and unit deviation over the phrase.
    for (let b = 0; normalise && b < bins; b++) {
      const row = out.subarray(b * frames, (b + 1) * frames)
      let mean = 0
      for (let f = 0; f < frames; f++) mean += row[f]
      mean /= frames || 1
      let v = 0
      for (let f = 0; f < frames; f++) v += (row[f] - mean) * (row[f] - mean)
      const inv = 1 / (Math.sqrt(v / (frames || 1)) + 1e-5)
      for (let f = 0; f < frames; f++) row[f] = (row[f] - mean) * inv
    }
    return { data: out, frames }
  }

  /** The last sample frame f needs, plus one. */
  static endSample(f: number): number {
    return NemoFeatures.firstSample(f) + LENGTH
  }

  /** Before normalisation, frame-major: for checking against kaldi-native-fbank. */
  raw(wave: Float32Array): Float32Array {
    const { data, frames } = this.compute(wave, false)
    const t = new Float32Array(data.length)
    for (let b = 0; b < this.numBins; b++) for (let f = 0; f < frames; f++) t[f * this.numBins + b] = data[b * frames + f]
    return t
  }
}

/** The model's vocabulary (tokens.txt: "piece id" a line) as text pieces, ▁ as a space. */
export function readTokens(text: string): { pieces: string[]; blank: number } {
  const pieces: string[] = []
  let blank = -1
  for (const line of text.split('\n')) {
    const m = /^(.*) (\d+)$/.exec(line.replace(/\r$/, ''))
    if (!m) continue
    const id = Number(m[2])
    pieces[id] = m[1]
    if (m[1] === '<blk>' || m[1] === '<blank>') blank = id
  }
  if (blank < 0) blank = pieces.length - 1
  return { pieces, blank }
}

/**
 * Greedy CTC, as sherpa-onnx does it: the likeliest token each frame,
 * repeats merged and blanks dropped, then the pieces joined (▁ starts a
 * word). `<unk>` is left out.
 */
export function ctcGreedy(logprobs: Float32Array, frames: number, vocab: number, blank: number, pieces: string[]): string {
  let prev = -1
  let text = ''
  for (let t = 0; t < frames; t++) {
    let best = 0
    let max = -Infinity
    const row = t * vocab
    for (let k = 0; k < vocab; k++) {
      const v = logprobs[row + k]
      if (v > max) {
        max = v
        best = k
      }
    }
    if (best !== blank && best !== prev) {
      const p = pieces[best] ?? ''
      if (p !== '<unk>') text += p.replace(/^▁/, ' ')
    }
    prev = best
  }
  return text.replace(/^ /, '')
}
