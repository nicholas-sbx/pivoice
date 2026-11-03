import { describe, expect, it } from 'vitest'
import { NemoFeatures, ctcGreedy, melBanks, readTokens } from '../src/captions/fbank'

/**
 * Parakeet's features, against the plainest possible reading of the same
 * steps (kaldi-native-fbank's, as sherpa-onnx sets them for NeMo models):
 * a direct DFT instead of the FFT, every frame cut out and reflected by
 * hand, and the mel triangles written out again from the formula.
 */

const RATE = 16_000
function signal(n: number): Float32Array {
  let seed = 12345
  return Float32Array.from({ length: n }, (_, i) => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    const t = i / RATE
    return 0.3 * Math.sin(2 * Math.PI * 440 * t) + 0.2 * Math.sin(2 * Math.PI * (300 + 3000 * t) * t) + ((seed >>> 8) / 16777216 - 0.5) * 0.02
  })
}

function naive(wave: Float32Array, bins: number): number[][] {
  const n = wave.length
  const frames = Math.floor((n + 80) / 160)
  const slaney = (hz: number) => (hz <= 1000 ? hz / (200 / 3) : 15 + Math.log(hz / 1000) / (Math.log(6.4) / 27))
  const inv = (m: number) => (m <= 15 ? (200 / 3) * m : 1000 * Math.exp((m - 15) * (Math.log(6.4) / 27)))
  const lo = slaney(0)
  const hi = slaney(8000)
  const out: number[][] = []
  for (let f = 0; f < frames; f++) {
    const x = new Array<number>(512).fill(0)
    for (let s = 0; s < 400; s++) {
      let i = 160 * f + 80 - 200 + s
      if (i < 0) i = -i - 1
      if (i >= n) i = 2 * n - 1 - i
      x[s] = wave[i]
    }
    for (let s = 399; s > 0; s--) x[s] -= 0.97 * x[s - 1]
    x[0] -= 0.97 * x[0]
    for (let s = 0; s < 400; s++) x[s] *= 0.5 - 0.5 * Math.cos((2 * Math.PI * s) / 400)
    const power: number[] = []
    for (let k = 0; k <= 256; k++) {
      let re = 0
      let im = 0
      for (let s = 0; s < 512; s++) {
        re += x[s] * Math.cos((2 * Math.PI * k * s) / 512)
        im -= x[s] * Math.sin((2 * Math.PI * k * s) / 512)
      }
      power.push(re * re + im * im)
    }
    const row: number[] = []
    for (let b = 0; b < bins; b++) {
      const l = inv(lo + (b * (hi - lo)) / (bins + 1))
      const c = inv(lo + ((b + 1) * (hi - lo)) / (bins + 1))
      const r = inv(lo + ((b + 2) * (hi - lo)) / (bins + 1))
      let e = 0
      for (let k = 0; k <= 256; k++) {
        const hz = k * 31.25
        if (hz > l && hz < r) e += ((hz <= c ? (hz - l) / (c - l) : (r - hz) / (r - c)) * 2) / (r - l) * power[k]
      }
      row.push(Math.log(Math.max(e, 1.1920928955078125e-7)))
    }
    out.push(row)
  }
  return out
}

describe("Parakeet's features", () => {
  it('has the mel triangles kaldi-native-fbank makes (librosa, Slaney)', () => {
    const banks = melBanks(80)
    expect(banks).toHaveLength(80)
    // The first triangle starts at DC, the last ends below Nyquist, and they march upward.
    expect(banks[0].first).toBe(1)
    for (let b = 1; b < 80; b++) expect(banks[b].first).toBeGreaterThanOrEqual(banks[b - 1].first)
    expect(banks[79].first + banks[79].w.length).toBeLessThanOrEqual(257)
  })

  it('matches a direct reading of the same steps', () => {
    const wave = signal(4000)
    const f = new NemoFeatures(80)
    const got = f.raw(wave)
    const want = naive(wave, 80)
    expect(got.length).toBe(want.length * 80)
    let worst = 0
    want.forEach((row, t) => row.forEach((v, b) => (worst = Math.max(worst, Math.abs(v - got[t * 80 + b])))))
    expect(worst).toBeLessThan(1e-3)
  })

  it('counts frames as kaldi does with snip_edges off', () => {
    expect(NemoFeatures.frames(16_000)).toBe(100)
    expect(NemoFeatures.frames(79)).toBe(0)
    expect(NemoFeatures.frames(80)).toBe(1)
  })

  it('normalises each bin over the phrase (NeMo per_feature)', () => {
    const { data, frames } = new NemoFeatures(80).compute(signal(8000))
    for (const b of [0, 40, 79]) {
      const row = Array.from(data.subarray(b * frames, (b + 1) * frames))
      const mean = row.reduce((a, v) => a + v, 0) / frames
      const sd = Math.sqrt(row.reduce((a, v) => a + (v - mean) ** 2, 0) / frames)
      expect(Math.abs(mean)).toBeLessThan(1e-4)
      expect(sd).toBeCloseTo(1, 3)
    }
  })
})

describe('greedy CTC', () => {
  const { pieces, blank } = readTokens('<unk> 0\n▁hel 1\nlo 2\n▁there 3\n, 4\n<blk> 5\n')

  it('reads tokens.txt, blank included', () => {
    expect(blank).toBe(5)
    expect(pieces[1]).toBe('▁hel')
  })

  it('merges repeats, drops blanks and <unk>, joins pieces into words', () => {
    // Frames: hel hel blk lo , blk unk there there
    const ids = [1, 1, 5, 2, 4, 5, 0, 3, 3]
    const vocab = 6
    const lp = new Float32Array(ids.length * vocab).fill(-10)
    ids.forEach((id, t) => (lp[t * vocab + id] = 0))
    expect(ctcGreedy(lp, ids.length, vocab, blank, pieces)).toBe('hello, there')
  })

  it('keeps a repeat that a blank separates', () => {
    const ids = [2, 5, 2]
    const lp = new Float32Array(ids.length * 6).fill(-10)
    ids.forEach((id, t) => (lp[t * 6 + id] = 0))
    expect(ctcGreedy(lp, 3, 6, blank, pieces)).toBe('lolo')
  })
})
