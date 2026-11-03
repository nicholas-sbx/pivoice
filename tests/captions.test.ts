import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { CaptionBoard } from '../src/captions/board'
import { CAPTION_DEFAULTS, sanitizeCaptions } from '../src/captions/config'
import { DECIMATE_TAPS, Decimator, decimateTaps } from '../src/captions/decimate'
import { CaptionGate, LevelMeter, type GateSink } from '../src/captions/gate'
import { MODELS, browserModel, checkManifest, inBrowser, modelOf } from '../src/captions/models'
import { downloadDecision, metered } from '../src/captions/network'
import { MAX_CAPTION_TEXT, RateLimit, cleanText, decodeCaption, encodeCaption } from '../src/captions/protocol'

interface GateCase {
  name: string
  preMs: number
  postMs: number
  levels: [number, number][]
  segments: { start: number; end: number; first: number; last: number }[]
}
const gateCases = (JSON.parse(readFileSync(new URL('./fixtures/caption-gate.json', import.meta.url), 'utf8')) as { cases: GateCase[] }).cases

describe('caption gate (the same cases as gate.go)', () => {
  for (const c of gateCases) {
    it(c.name, () => {
      const gate = new CaptionGate({ sampleRate: 48_000, preMs: c.preMs, postMs: c.postMs }, 1000)
      const segs: { start: number; end: number; samples: number[] }[] = []
      let block = 0
      const sink: GateSink = {
        start: () => segs.push({ start: block, end: -1, samples: [] }),
        audio: (buf, from, to) => {
          for (let i = from; i < to; i++) segs[segs.length - 1].samples.push(buf[i])
        },
        end: () => (segs[segs.length - 1].end = block)
      }
      let k = 0
      for (const [count, level] of c.levels) {
        for (let n = 0; n < count; n++, block++) {
          const raw = new Float32Array(128)
          for (let i = 0; i < 128; i++) raw[i] = k++
          gate.push(raw, level, sink)
        }
      }
      expect(segs.map(s => ({ start: s.start, end: s.end, first: s.samples[0], last: s.samples[s.samples.length - 1] }))).toEqual(c.segments)
      // Every segment is one unbroken run of the mic: nothing missed, nothing twice.
      for (const s of segs) s.samples.forEach((v, i) => expect(v).toBe(s.samples[0] + i))
    })
  }

  it('reset ends an open segment and forgets the pre-roll', () => {
    const gate = new CaptionGate({ sampleRate: 48_000, preMs: 100, postMs: 100 }, 1000)
    const log: string[] = []
    const sink: GateSink = { start: () => log.push('start'), audio: (_b, f, t) => log.push(`audio ${t - f}`), end: () => log.push('end') }
    gate.push(new Float32Array(128), 0, sink)
    gate.push(new Float32Array(128), 1, sink)
    gate.reset(sink)
    gate.push(new Float32Array(128), 1, sink)
    expect(log).toEqual(['start', 'audio 128', 'audio 128', 'end', 'start', 'audio 128'])
  })

  it("measures the ring's level over 1024 samples, as the analyser does", () => {
    const m = new LevelMeter(128, 1024)
    const loud = new Float32Array(128).fill(0.1)
    expect(m.push(loud, 128)).toBeCloseTo(0.1 / Math.sqrt(1), 6)
    for (let i = 0; i < 7; i++) m.push(loud, 128)
    expect(m.push(new Float32Array(128), 128)).toBeCloseTo(Math.sqrt((7 * 0.01) / 8), 6)
  })
})

describe('decimator (the same filter as decimate.go)', () => {
  it('is the Kaiser-windowed sinc both sides compute', () => {
    const h = decimateTaps()
    expect(h.length).toBe(DECIMATE_TAPS)
    // From the same formula in float64, independently (also checked in decimate_test.go).
    expect(h[0]).toBeCloseTo(3.2188470192927945e-5, 15)
    expect(h[20]).toBeCloseTo(0.002275942434150705, 15)
    expect(h[47]).toBeCloseTo(0.30418056037248564, 15)
    expect(h.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12)
  })

  function gainAt(hz: number): number {
    const d = new Decimator()
    const n = 48_000
    const x = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * hz * i) / 48_000))
    const out = new Float32Array(n / 3)
    const got = d.push(x, 0, n, out)
    let s = 0
    for (let i = 1000; i < got; i++) s += out[i] * out[i]
    return 10 * Math.log10(s / (got - 1000) / 0.5)
  }

  it('passes speech and stops what would fold back into it', () => {
    expect(Math.abs(gainAt(1000))).toBeLessThan(0.05)
    expect(Math.abs(gainAt(5000))).toBeLessThan(0.1)
    expect(gainAt(8400)).toBeLessThan(-60)
    expect(gainAt(12_000)).toBeLessThan(-60)
  })

  it('gives the same out in pieces as in one go', () => {
    const x = Float32Array.from({ length: 4000 }, (_, i) => Math.sin(i * 0.01) + 0.3 * Math.sin(i * 0.37))
    const whole = new Float32Array(2000)
    const nWhole = new Decimator().push(x, 0, x.length, whole)
    const d = new Decimator()
    const parts = new Float32Array(2000)
    let at = 0
    for (const [a, b] of [
      [0, 1],
      [1, 129],
      [129, 1000],
      [1000, 4000]
    ])
      at += d.push(x, a, b, parts, at)
    expect(at).toBe(nWhole)
    expect(Array.from(parts.subarray(0, at))).toEqual(Array.from(whole.subarray(0, nWhole)))
  })
})

describe('captions on the wire', () => {
  it('round-trips, and cleans what it carries', () => {
    const m = decodeCaption(encodeCaption({ s: 7, u: 3, t: 'hello\u0000 there‮', f: true }))
    expect(m).toEqual({ s: 7, u: 3, t: 'hello there', f: true })
  })

  it("refuses anything that isn't one", () => {
    for (const bad of [
      new ArrayBuffer(8),
      'not json',
      JSON.stringify({ v: 2, s: 1, u: 1, t: 'x', f: true }),
      JSON.stringify({ v: 1, s: -1, u: 1, t: 'x', f: true }),
      JSON.stringify({ v: 1, s: 1, u: 1.5, t: 'x', f: true }),
      JSON.stringify({ v: 1, s: 1, u: 1, t: 3, f: true }),
      JSON.stringify({ v: 1, s: 1, u: 1, t: 'x', f: 'yes' }),
      JSON.stringify({ v: 1, s: 1, u: 1, t: 'x'.repeat(3000), f: true })
    ])
      expect(decodeCaption(bad)).toBeNull()
  })

  it('cleans and encodes as the app does (tests/fixtures/caption-text.json)', () => {
    const f = JSON.parse(readFileSync(new URL('./fixtures/caption-text.json', import.meta.url), 'utf8')) as {
      clean: { in: string; out: string }[]
      encode: { s: number; u: number; t: string; f: boolean; json: string }[]
    }
    for (const c of f.clean) expect(cleanText(c.in)).toBe(c.out)
    for (const c of f.encode) expect(encodeCaption({ s: c.s, u: c.u, t: c.t, f: c.f })).toBe(c.json)
  })

  it('keeps the end of a long phrase, from a word', () => {
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ')
    const t = cleanText(long)
    expect(t.length).toBeLessThanOrEqual(MAX_CAPTION_TEXT)
    expect(t.endsWith('word199')).toBe(true)
    expect(t.startsWith('word')).toBe(true)
  })

  it('holds anyone to a rate', () => {
    const r = new RateLimit(10, 5)
    let ok = 0
    for (let i = 0; i < 20; i++) if (r.take(1000)) ok++
    expect(ok).toBe(5)
    expect(r.take(1100)).toBe(true)
  })
})

describe('caption board', () => {
  const msg = (s: number, u: number, t: string, f: boolean) => encodeCaption({ s, u, t, f })

  it('shows a phrase as it grows, then finished, then the next', () => {
    const b = new CaptionBoard()
    b.receive('a', msg(1, 0, 'hel', false), 0)
    b.receive('a', msg(1, 0, 'hello there', false), 10)
    expect(b.view('a')).toMatchObject({ lines: ['hello there'], live: true })
    b.receive('a', msg(1, 0, 'hello there', true), 20)
    b.receive('a', msg(1, 1, 'how are', false), 30)
    expect(b.view('a')).toMatchObject({ lines: ['hello there', 'how are'], live: true })
  })

  it('ignores old phrases, and starts over for a new run', () => {
    const b = new CaptionBoard()
    b.receive('a', msg(1, 5, 'five', true), 0)
    expect(b.receive('a', msg(1, 4, 'four', false), 1)).toBe(false)
    b.receive('a', msg(2, 0, 'again', false), 2)
    expect(b.view('a')?.lines).toEqual(['again'])
  })

  it('keeps an unfinished phrase when the next one starts', () => {
    const b = new CaptionBoard()
    b.receive('a', msg(1, 0, 'cut off', false), 0)
    b.receive('a', msg(1, 1, 'next', false), 1)
    expect(b.view('a')?.lines).toEqual(['cut off', 'next'])
  })

  it('clears captions once they have been quiet long enough', () => {
    const b = new CaptionBoard()
    b.receive('a', msg(1, 0, 'hi', true), 0)
    expect(b.expire(1000, 5000)).toEqual([])
    expect(b.expire(6000, 5000)).toEqual(['a'])
    expect(b.view('a')).toBeNull()
  })

  it("doesn't let anyone flood it", () => {
    const b = new CaptionBoard()
    let shown = 0
    for (let i = 0; i < 500; i++) if (b.receive('a', msg(1, 0, `w${i}`, false), 0)) shown++
    expect(shown).toBeLessThanOrEqual(50)
  })
})

describe('downloading the model', () => {
  it('reads the connection', () => {
    expect(metered(undefined)).toBe('unknown')
    expect(metered({ type: 'cellular' })).toBe('yes')
    expect(metered({ type: 'wifi', saveData: true })).toBe('yes')
    expect(metered({ type: 'ethernet' })).toBe('no')
    expect(metered({})).toBe('unknown')
  })

  it('asks on mobile data, and on a phone that will not say', () => {
    expect(downloadDecision('wifi', 'no', true)).toBe('download')
    expect(downloadDecision('wifi', 'yes', false)).toBe('ask')
    expect(downloadDecision('wifi', 'unknown', true)).toBe('ask')
    expect(downloadDecision('wifi', 'unknown', false)).toBe('download')
    expect(downloadDecision('ask', 'no', false)).toBe('ask')
    expect(downloadDecision('always', 'yes', true)).toBe('download')
  })

  it('takes only a manifest that matches the pinned files', () => {
    const m = modelOf('parakeet-ctc-110m-en')!
    const good = {
      v: 1,
      id: m.id,
      files: m.files.map(([path, sha, size]) => ({ path, size, sha256: sha, encoding: 'gzip', parts: [{ name: `${path}.gz.0`, size: 100 }] }))
    }
    expect(checkManifest(m, good)).not.toBeNull()
    const swapped = structuredClone(good)
    swapped.files[0].sha256 = '0'.repeat(64)
    expect(checkManifest(m, swapped)).toBeNull()
    const escape = structuredClone(good)
    escape.files[0].parts[0].name = '../../evil'
    expect(checkManifest(m, escape)).toBeNull()
    const big = structuredClone(good)
    big.files[0].parts[0].size = 64 * 1024 * 1024
    expect(checkManifest(m, big)).toBeNull()
  })

  it('pins every file of every model', () => {
    expect(MODELS.map(m => m.id)).toEqual(['vosk-small-en', 'vosk-lgraph-en', 'parakeet-ctc-110m-en', 'fastconformer-ctc-480ms-en'])
    for (const m of MODELS) for (const [path, sha, size] of m.files) expect([path, /^[0-9a-f]{64}$/.test(sha), size > 0]).toEqual([path, true, true])
  })

  it('keeps Vosk large to the app, and a browser runs the default for it', () => {
    expect(MODELS.filter(inBrowser).map(m => m.id)).toEqual(['vosk-small-en', 'parakeet-ctc-110m-en', 'fastconformer-ctc-480ms-en'])
    expect(browserModel('vosk-lgraph-en')).toBe('vosk-small-en')
    expect(browserModel('parakeet-ctc-110m-en')).toBe('parakeet-ctc-110m-en')
  })

  it("is the same catalog the app uses (native/internal/asr/models.json)", () => {
    const here = readFileSync(new URL('../src/captions/models.json', import.meta.url), 'utf8')
    const app = readFileSync(new URL('../native/internal/asr/models.json', import.meta.url), 'utf8')
    expect(app).toBe(here)
  })
})

describe('caption settings', () => {
  it('keeps what makes sense and defaults the rest', () => {
    expect(sanitizeCaptions(undefined)).toEqual(CAPTION_DEFAULTS)
    const c = sanitizeCaptions({ model: 'parakeet-ctc-110m-en', preRollMs: 99999, lines: 2.6, download: 'sometimes', send: false, threads: 0 })
    expect(c).toMatchObject({ model: 'parakeet-ctc-110m-en', preRollMs: 1000, lines: 3, download: 'wifi', send: false, threads: 1 })
    expect(sanitizeCaptions({ model: 'whisper' }).model).toBe('vosk-small-en')
  })
})
