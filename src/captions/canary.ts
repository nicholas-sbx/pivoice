import type { CaptionLanguage } from './config'
import { NemoFeatures } from './fbank'
import type { Recogniser } from './worker-core'

/** The pinned sherpa-onnx Canary export: encoder, then one token and its position per decoder step. */
export interface CanaryModel {
  /** Normalised, frame-major [1, frames, 128] features; returns the encoded frame count. */
  encode(features: Float32Array, frames: number): Promise<number>
  step(token: number, position: number): Promise<Float32Array>
  /** Drop the encoder output and decoder caches between reads, including failed reads. */
  reset(): void
}

/**
 * Canary 180M Flash is an attention decoder, not CTC: every re-read starts
 * with the task/language prompt and fresh decoder caches. The gate and
 * worker-core bound the phrase and decide when a re-read is worth doing.
 */
export class Canary implements Recogniser {
  readonly streaming = false
  private phrase = new Float32Array(16_000 * 4)
  private count = 0
  private features = new NemoFeatures(128)
  private prompt: number[]
  private eos: number

  constructor(private model: CanaryModel, private pieces: string[], language: CaptionLanguage) {
    const token = (name: string) => {
      const id = pieces.indexOf(`<|${name}|>`)
      if (id < 0) throw new Error(`Canary vocabulary has no ${name}`)
      return id
    }
    this.eos = token('endoftext')
    this.prompt = ['startofcontext', 'startoftranscript', 'emo:undefined', language, language, 'pnc', 'noitn', 'notimestamp', 'nodiarize'].map(token)
  }

  get held() { return this.count }

  accept(pcm: Float32Array): boolean {
    if (this.count + pcm.length > this.phrase.length) {
      const larger = new Float32Array(Math.max(this.phrase.length * 2, this.count + pcm.length))
      larger.set(this.phrase.subarray(0, this.count))
      this.phrase = larger
    }
    this.phrase.set(pcm, this.count)
    this.count += pcm.length
    return false
  }

  result() { return '' }
  configure() {}
  partial() { return this.read(false) }

  async finish(): Promise<string> {
    try { return await this.read(true) }
    finally { this.count = 0 }
  }

  private async read(final: boolean): Promise<string> {
    if (this.count < 1600) return ''
    const { data, frames } = this.features.compute(this.phrase.subarray(0, this.count))
    // NeMo's CTC exports take bin-major input; this encoder takes frame-major.
    const input = new Float32Array(data.length)
    for (let f = 0; f < frames; f++) for (let b = 0; b < 128; b++) input[f * 128 + b] = data[b * frames + f]
    try {
      const encodedFrames = await this.model.encode(input, frames)
      let logits: Float32Array = new Float32Array(0)
      for (let pos = 0; pos < this.prompt.length; pos++) logits = await this.model.step(this.prompt[pos], pos)
      // sherpa-onnx's 30 tokens/second guard, also within the export's 1024 positions.
      const limit = Math.min(1024 - this.prompt.length, Math.floor(encodedFrames * 8 * 0.3) + 1)
      let text = ''
      const generated: number[] = []
      for (let i = 0; i < limit; i++) {
        if (logits.length !== this.pieces.length) throw new Error('Canary output does not match its vocabulary')
        let best = 0
        for (let k = 1; k < logits.length; k++) if (logits[k] > logits[best]) best = k
        if (best === this.eos) return text.trim()
        generated.push(best)
        // A cut-off word can send an unfinished preview into a loop. Wait
        // for more audio instead of spending its whole token budget on it.
        // Final reads may legitimately contain repetitions and keep them.
        if (!final && repeatingTail(generated)) return ''
        const piece = this.pieces[best] ?? ''
        if (!piece.startsWith('<|') && piece !== '<unk>' && piece !== '<pad>') text += piece.replaceAll('▁', ' ')
        if (i + 1 < limit) logits = await this.model.step(best, this.prompt.length + i)
      }
      // The duration guard is not an end-of-transcript prediction. In a
      // preview, returning nothing keeps the last completed re-read visible.
      return ''
    } finally {
      this.model.reset()
    }
  }
}

/** A block of 1–4 tokens repeated at least four times, across at least eight tokens. */
function repeatingTail(tokens: number[]): boolean {
  for (let width = 1; width <= 4; width++) {
    const span = width * Math.max(4, Math.ceil(8 / width))
    if (tokens.length < span) continue
    let same = true
    for (let i = 1; i <= span; i++) {
      if (tokens[tokens.length - i] !== tokens[tokens.length - 1 - ((i - 1) % width)]) { same = false; break }
    }
    if (same) return true
  }
  return false
}
