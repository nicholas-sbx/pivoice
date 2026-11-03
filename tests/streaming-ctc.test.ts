import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NemoFeatures } from '../src/captions/fbank'
import { onnxMetadata, streamingCtcMeta } from '../src/captions/onnx-meta'
import { LEAD_IN, StreamingCtc, TAIL_FRAMES, type StreamingModel } from '../src/captions/streaming-ctc'

/**
 * The streaming FastConformer's driver, with a pretend model that records
 * what it's given and says what it's told to. The same cases are in
 * tests/fixtures/streaming-ctc.json for the app's (streamctc_test.go).
 */

interface Fixture {
  signal: { seed: number; samples: number }
  lead: number
  tail: number
  /** Feature values the app's must match: [frame, bin, value]. */
  features: [number, number, number][]
  /** Each export's chunks. */
  shapes: { model: string; window: number; shift: number; cases: { name: string; samples: number; chunks: number[]; padded: number }[] }[]
}
const fixture = JSON.parse(readFileSync(new URL('./fixtures/streaming-ctc.json', import.meta.url), 'utf8')) as Fixture

/** The fixture's signal: a tone, a chirp and a little noise, as the app makes it too. */
export function signal(seed: number, n: number): Float32Array {
  let s = seed >>> 0
  return Float32Array.from({ length: n }, (_, i) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    const t = i / 16_000
    return 0.3 * Math.sin(2 * Math.PI * 440 * t) + 0.2 * Math.sin(2 * Math.PI * (300 + 3000 * t) * t) + ((s >>> 8) / 16777216 - 0.5) * 0.02
  })
}

const PIECES = ['<unk>', '▁hel', 'lo', '▁there', '▁you', '<blk>']
const BLANK = 5

/** A model that keeps every window it's given, and emits one output frame per chunk from a script (blank when it runs out). */
function fake(window: number, shift: number, script: number[] = []) {
  const seen: Float32Array[] = []
  let resets = 0
  const model: StreamingModel = {
    window,
    shift,
    async run(x) {
      seen.push(x.slice())
      const lp = new Float32Array(PIECES.length).fill(-10)
      lp[script[seen.length - 1] ?? BLANK] = 0
      return { logprobs: lp, frames: 1 }
    },
    reset() {
      resets++
    }
  }
  return { model, seen, resets: () => resets }
}

async function feed(ctc: StreamingCtc, x: Float32Array, sizes = [320, 1000, 7, 4096]) {
  const ended: string[] = []
  for (let at = 0, k = 0; at < x.length; k++) {
    const n = Math.min(sizes[k % sizes.length], x.length - at)
    if (await ctc.accept(x.subarray(at, at + n))) ended.push(ctc.result())
    at += n
  }
  return ended
}

describe('streaming CTC', () => {
  // The words and phrases below go by the 480 ms export's chunks.
  const { window, shift } = fixture.shapes.find(s => s.model === '480 ms')!

  it('adds as much silence before and after as the fixture says', () => {
    expect(LEAD_IN).toBe(fixture.lead)
    expect(TAIL_FRAMES).toBe(fixture.tail)
  })

  for (const { model, window, shift, cases } of fixture.shapes) {
    for (const c of cases) {
      it(`chunks, ${model}: ${c.name}`, async () => {
        const f = fake(window, shift)
        const ctc = new StreamingCtc(f.model, PIECES, BLANK)
        const x = signal(fixture.signal.seed, c.samples)
        await feed(ctc, x)
        await ctc.finish()
        // Where each chunk started, in frames, and how much silence the end needed.
        expect(f.seen.length).toBe(c.chunks.length)
        // Each window is the frames of the whole signal (and its silence before and after), as one computation of them all would have them.
        const whole = new Float32Array(c.padded)
        whole.set(x, fixture.lead)
        const { data, frames } = new NemoFeatures(80).compute(whole, false)
        c.chunks.forEach((start, k) => {
          const got = f.seen[k]
          let worst = 0
          for (let b = 0; b < 80; b++) for (let t = 0; t < window; t++) worst = Math.max(worst, Math.abs(got[b * window + t] - data[b * frames + start + t]))
          expect(worst).toBeLessThan(1e-5)
        })
        // Enough silence for a chunk or two past the first that reaches the end of the segment (at least tail frames of them), and no more.
        const last = c.chunks[c.chunks.length - 1] + window
        expect(NemoFeatures.endSample(last - 1)).toBe(c.padded)
        const real = NemoFeatures.frames(fixture.lead + c.samples)
        const reaching = c.chunks.findIndex(start => start + window >= real)
        const after = c.chunks.length - 1 - reaching
        expect(after).toBe(Math.max(1, Math.ceil(fixture.tail / shift)))
      })
    }
  }

  it("matches the fixture's features (the app is held to the same)", async () => {
    const x = signal(fixture.signal.seed, fixture.signal.samples)
    const { data, frames } = new NemoFeatures(80).compute(x, false)
    for (const [t, b, v] of fixture.features) expect(data[b * frames + t]).toBeCloseTo(v, 4)
  })

  it('says the words as they come, and only ever adds to them', async () => {
    // Output frames: hel hel blk lo blk there <unk> you
    const f = fake(window, shift, [1, 1, 5, 2, 5, 3, 0, 4])
    const ctc = new StreamingCtc(f.model, PIECES, BLANK)
    const said: string[] = []
    const x = signal(1, 16_000 * 6)
    for (let at = 0; at < x.length; at += 1600) {
      await ctc.accept(x.subarray(at, at + 1600))
      if (ctc.text !== said[said.length - 1]) said.push(ctc.text)
    }
    for (let i = 1; i < said.length; i++) expect(said[i].startsWith(said[i - 1])).toBe(true)
    expect(await ctc.finish()).toBe('hello there you')
    expect(f.resets()).toBe(1)
    expect(ctc.text).toBe('')
  })

  it('ends a long phrase where a word starts, and carries on without starting again', async () => {
    // One word a chunk: past 3 output frames, the next word ends the phrase before it.
    const f = fake(window, shift, [1, 2, 3, 4, 3, 4, 3, 4, 3])
    const ctc = new StreamingCtc(f.model, PIECES, BLANK)
    ctc.maxPhraseFrames = 3
    const ended = await feed(ctc, signal(2, 16_000 * 6))
    const rest = await ctc.finish()
    expect(ended).toEqual(['hello there', 'you there you'])
    expect([...ended, rest].join(' ')).toBe('hello there you there you there you there')
    // Cut there, the model was never told to start again.
    expect(f.resets()).toBe(1)
  })

  it('finishes a segment shorter than a chunk, and one with nothing in it', async () => {
    const f = fake(window, shift, [1])
    const ctc = new StreamingCtc(f.model, PIECES, BLANK)
    await ctc.accept(signal(3, 800))
    expect(await ctc.finish()).toBe('hel')
    expect(f.seen.length).toBe(2)
    expect(await ctc.finish()).toBe('')
    expect(f.seen.length).toBe(2)
  })
})

describe('ONNX metadata', () => {
  /** A ModelProto with a graph to skip and a few metadata_props. */
  function model(props: Record<string, string>): Uint8Array {
    const enc = new TextEncoder()
    const bytes: number[] = []
    const varint = (v: number) => {
      while (v >= 0x80) {
        bytes.push((v & 0x7f) | 0x80)
        v = Math.floor(v / 128)
      }
      bytes.push(v)
    }
    const field = (n: number, body: Uint8Array | number[]) => {
      varint((n << 3) | 2)
      varint(body.length)
      bytes.push(...body)
    }
    varint((1 << 3) | 0)
    varint(8)
    field(7, new Uint8Array(300).fill(0x42))
    for (const [k, v] of Object.entries(props)) {
      const kb = enc.encode(k)
      const vb = enc.encode(v)
      field(14, [(1 << 3) | 2, kb.length, ...kb, (2 << 3) | 2, vb.length, ...vb])
    }
    return Uint8Array.from(bytes)
  }
  const good = {
    window_size: '65',
    chunk_shift: '56',
    normalize_type: '',
    subsampling_factor: '8',
    cache_last_channel_dim1: '17',
    cache_last_channel_dim2: '70',
    cache_last_channel_dim3: '512',
    cache_last_time_dim1: '17',
    cache_last_time_dim2: '512',
    cache_last_time_dim3: '8'
  }

  it("reads a streaming export's", () => {
    expect(streamingCtcMeta(onnxMetadata(model(good)))).toEqual({ window: 65, shift: 56, channel: [1, 17, 70, 512], time: [1, 17, 512, 8] })
  })

  it("refuses one this can't drive", () => {
    expect(() => streamingCtcMeta(onnxMetadata(model({ ...good, normalize_type: 'per_feature' })))).toThrow(/normalised/)
    expect(() => streamingCtcMeta(onnxMetadata(model({ ...good, chunk_shift: '' })))).toThrow(/chunk_shift/)
    expect(() => onnxMetadata(model(good).subarray(0, 200))).toThrow(/cut short/)
  })
})
