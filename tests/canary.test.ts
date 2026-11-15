import { describe, expect, it } from 'vitest'
import { Canary, type CanaryModel } from '../src/captions/canary'
import { CAPTION_DEFAULTS, CAPTION_LANGUAGES, sanitizeCaptions, type CaptionLanguage } from '../src/captions/config'
import { browserModel, modelOf, streams } from '../src/captions/models'

const pieces = ['<unk>', '<|endoftext|>', '<|startofcontext|>', '<|startoftranscript|>', '<|emo:undefined|>', '<|en|>', '<|de|>', '<|es|>', '<|fr|>', '<|pnc|>', '<|noitn|>', '<|notimestamp|>', '<|nodiarize|>', '▁Hello', ',', '▁world', '!']
const id = (piece: string) => pieces.indexOf(piece)
const wave = () => Float32Array.from({ length: 16_000 }, (_, i) => 0.2 * Math.sin(i * 0.12))

function fake(script = ['▁Hello', ',', '▁world', '!', '<|endoftext|>']) {
  const steps: [number, number][] = []
  const inputs: { features: Float32Array; frames: number }[] = []
  let reads = 0
  let resets = 0
  const model: CanaryModel = {
    async encode(features, frames) {
      reads = 0
      inputs.push({ features, frames })
      return Math.ceil(frames / 8)
    },
    async step(token, position) {
      steps.push([token, position])
      const logits = new Float32Array(pieces.length).fill(-10)
      // The first eight steps prime the prompt; the ninth predicts the first text token.
      const next = position < 8 ? '<|endoftext|>' : script[Math.min(reads++, script.length - 1)]
      logits[id(next)] = 0
      return logits
    },
    reset() { resets++ }
  }
  return { model, steps, inputs, resets: () => resets }
}

describe('Canary 180M Flash', () => {
  it('is offered on both platforms, and uses phrase re-reads rather than streaming', () => {
    expect(modelOf('canary-180m-flash')?.engine).toBe('nemo-canary')
    expect(browserModel('canary-180m-flash')).toBe('canary-180m-flash')
    expect(streams('nemo-canary')).toBe(false)
    expect(streams('nemo-ctc')).toBe(false)
    expect(streams('nemo-ctc-streaming')).toBe(true)
  })

  for (const language of Object.keys(CAPTION_LANGUAGES) as CaptionLanguage[]) {
    it(`prompts for ${language} transcription with punctuation, and advances token positions`, async () => {
      const f = fake()
      const rec = new Canary(f.model, pieces, language)
      const pcm = wave()
      rec.accept(pcm.subarray(0, 321))
      rec.accept(pcm.subarray(321))
      expect(rec.held).toBe(pcm.length)
      expect(await rec.partial()).toBe('Hello, world!')
      expect(rec.held).toBe(pcm.length)
      expect(f.steps.slice(0, 9)).toEqual(['startofcontext', 'startoftranscript', 'emo:undefined', language, language, 'pnc', 'noitn', 'notimestamp', 'nodiarize'].map((s, pos) => [id(`<|${s}|>`), pos]))
      expect(f.steps.slice(9)).toEqual(['▁Hello', ',', '▁world', '!'].map((s, i) => [id(s), 9 + i]))
      expect(await rec.finish()).toBe('Hello, world!')
      expect(rec.held).toBe(0)
      expect(f.resets()).toBe(2)
      expect(await rec.finish()).toBe('')
      expect(f.inputs).toHaveLength(2)
    })
  }

  it('feeds 128 normalised bins per frame in the encoder layout', async () => {
    const f = fake()
    const rec = new Canary(f.model, pieces, 'en')
    rec.accept(wave())
    await rec.finish()
    const { features, frames } = f.inputs[0]
    expect(frames).toBe(100)
    expect(features.length).toBe(frames * 128)
    for (let b = 0; b < 128; b++) {
      let sum = 0
      for (let t = 0; t < frames; t++) sum += features[t * 128 + b]
      expect(Math.abs(sum / frames)).toBeLessThan(1e-5)
    }
  })

  it('stops on EOS even as the first prediction and never captions control tokens', async () => {
    for (const [script, text] of [[['<|endoftext|>'], ''], [['<unk>', '<|notimestamp|>', '▁Hello', '<|endoftext|>'], 'Hello']] as const) {
      const f = fake([...script])
      const rec = new Canary(f.model, pieces, 'en')
      rec.accept(wave())
      expect(await rec.finish()).toBe(text)
      expect(f.resets()).toBe(1)
    }
  })

  it('bounds a decoder that never predicts EOS and withholds its unfinished text', async () => {
    const f = fake(['▁Hello'])
    const rec = new Canary(f.model, pieces, 'en', true)
    rec.accept(wave())
    expect(await rec.finish()).toBe('')
    // ceil(100 / 8) encoded frames * 8 * .3 + 1 = 32 text tokens.
    expect(f.steps).toHaveLength(9 + 31)
    expect(f.resets()).toBe(1)
  })

  it('abandons a looping preview early but preserves legitimate repetitions in a final read', async () => {
    const f = fake([...Array.from({ length: 8 }, () => ['▁Hello', ',']).flat(), '<|endoftext|>'])
    const rec = new Canary(f.model, pieces, 'en', true)
    rec.accept(wave())
    expect(await rec.partial()).toBe('')
    expect(f.steps.length).toBeLessThan(9 + 16)
    expect(rec.held).toBe(16_000)
    expect(await rec.finish()).toBe(Array(8).fill('Hello,').join(' '))
    expect(f.resets()).toBe(2)
  })

  it('keeps bounded output by default and applies suppression changes to the next read', async () => {
    const f = fake(['▁Hello'])
    const rec = new Canary(f.model, pieces, 'en')
    rec.accept(wave())
    expect((await rec.partial()).split(' ')).toHaveLength(32)
    expect(f.steps).toHaveLength(9 + 31)
    rec.configure({ ...CAPTION_DEFAULTS, suppressUnstableOutput: true })
    expect(await rec.partial()).toBe('')
    expect(f.steps.length).toBeLessThan(2 * (9 + 31))
    expect(rec.held).toBe(16_000)
    rec.configure({ ...CAPTION_DEFAULTS, suppressUnstableOutput: false })
    expect((await rec.finish()).split(' ')).toHaveLength(32)
    expect(rec.held).toBe(0)
    expect(f.resets()).toBe(3)
  })

  it('defaults suppression off for old preferences and only accepts booleans', () => {
    expect(sanitizeCaptions({ model: 'canary-180m-flash' }).suppressUnstableOutput).toBe(false)
    expect(sanitizeCaptions({ suppressUnstableOutput: true }).suppressUnstableOutput).toBe(true)
    expect(sanitizeCaptions({ suppressUnstableOutput: false }).suppressUnstableOutput).toBe(false)
    for (const value of ['true', 1, null]) expect(sanitizeCaptions({ suppressUnstableOutput: value }).suppressUnstableOutput).toBe(false)
  })

  it('discards phrase state after a failed read', async () => {
    const f = fake()
    f.model.step = async () => { throw new Error('inference failed') }
    const rec = new Canary(f.model, pieces, 'en')
    rec.accept(wave())
    await expect(rec.finish()).rejects.toThrow('inference failed')
    expect(rec.held).toBe(0)
    expect(f.resets()).toBe(1)
  })

  it('leaves other models and old preferences on English by default', () => {
    expect(CAPTION_DEFAULTS.language).toBe('en')
    for (const language of Object.keys(CAPTION_LANGUAGES)) expect(sanitizeCaptions({ language }).language).toBe(language)
    for (const language of [undefined, 'auto', 'it', 'toString', '__proto__', 42]) expect(sanitizeCaptions({ language }).language).toBe('en')
  })
})
