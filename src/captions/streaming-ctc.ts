import { NemoFeatures } from './fbank'

/**
 * A cache-aware streaming CTC model (NVIDIA NeMo's FastConformer, as
 * sherpa-onnx exports it), fed as it hears: the audio becomes log-mel
 * frames as it arrives (fbank.ts, the NeMo way, not normalised: the model
 * wants them as they are), the model reads `window` frames at a time,
 * moving on `shift` each time, and hands back its caches with each chunk's
 * output, so no audio is ever read twice. Greedy CTC over each chunk's
 * output only ever adds to the words: what's been said stays said.
 *
 * native/internal/asr/streamctc.go is the same, for the app; both are held
 * to tests/fixtures/streaming-ctc.json.
 */

/**
 * Silence before each segment, samples: the model starts from quiet, as it
 * learned to. Without it the first word of a segment that starts with one
 * was often lost: on 29 minutes of speech that starts straight away
 * (MS-SNSD's clean test set), 6.6% of words were wrong without it, 4.9%
 * with 200 ms (300 or 400 ms was no better). The gate's pre-roll is the
 * mic's own audio from before your ring lit, and comes after this.
 */
export const LEAD_IN = 3200
const SILENCE = new Float32Array(LEAD_IN)

/**
 * Silence after a segment, frames: at least this much past the last chunk
 * with any of it in, and at least one chunk. The model says a word up to a
 * chunk after it hears it, or two of the 80 ms export's 0.16 s ones:
 * stopping sooner lost the end of the last word (in one segment in seven,
 * with the 480 ms export).
 */
export const TAIL_FRAMES = 30

/** How many chunks after the last with any of the segment in. */
export function tailChunks(shift: number): number {
  return Math.max(1, Math.ceil(TAIL_FRAMES / shift))
}

/** One chunk through the model: its output, and its caches kept for the next. */
export interface StreamingModel {
  readonly window: number
  readonly shift: number
  /** x: bins × window, bin-major (the model's [1, bins, window]). Log-probabilities out, frames × vocab. */
  run(x: Float32Array): Promise<{ logprobs: Float32Array; frames: number }>
  /** Back to the start: the caches empty. */
  reset(): void
}

export class StreamingCtc {
  readonly bins: number
  private features: NemoFeatures
  // The audio not yet made into frames (and what the next frame shares with the last), from sample `sampleBase`.
  private samples = new Float32Array(16_000)
  private sampleBase = 0
  private heard = 0
  // Frames not yet read by the model as new, frame-major, from frame `frameBase`.
  private frames: Float32Array
  private frameBase = 0
  private made = 0
  /** The next chunk's first frame. */
  private next = 0
  private x: Float32Array
  // Greedy CTC.
  private prev = -1
  private outFrame = 0
  private phrase = ''
  private phraseStart = 0
  private ended = ''
  /** Long phrases: past this many output frames, the next word starts a new phrase. */
  maxPhraseFrames = Infinity

  constructor(
    private model: StreamingModel,
    private pieces: string[],
    private blank: number,
    bins = 80
  ) {
    this.bins = bins
    this.features = new NemoFeatures(bins)
    this.frames = new Float32Array(bins * model.window * 4)
    this.x = new Float32Array(bins * model.window)
  }

  /** Audio heard in this segment so far, samples. */
  get held(): number {
    return Math.max(0, this.heard - LEAD_IN)
  }

  /** Long phrases are cut at a word, this long in, s (each output frame is 80 ms of audio). */
  set maxPhraseSec(sec: number) {
    this.maxPhraseFrames = sec * 12.5
  }

  /** The phrase so far. */
  get text(): string {
    return this.phrase.replace(/^ /, '')
  }

  /** More audio, 16 kHz, [-1, 1]. True: a long phrase ended at a word; take it with result(). */
  async accept(pcm: Float32Array): Promise<boolean> {
    if (this.heard === 0 && pcm.length) this.append(SILENCE)
    this.append(pcm)
    await this.decodeReady()
    return this.ended !== ''
  }

  /** The phrase a long one ended (accept said so). */
  result(): string {
    const t = this.ended.replace(/^ /, '')
    this.ended = ''
    return t
  }

  /**
   * The end of the segment: silence after it, enough for a chunk or two past
   * the last with any of the segment in (TAIL_FRAMES), and everything read.
   * Its words, and ready for the next with the caches empty.
   */
  async finish(): Promise<string> {
    if (this.heard > 0) {
      const { window, shift } = this.model
      const real = NemoFeatures.frames(this.heard)
      const last = (Math.max(0, Math.ceil((real - window) / shift)) + tailChunks(shift)) * shift
      if (this.next <= last) {
        const pad = NemoFeatures.endSample(last + window - 1) - this.heard
        if (pad > 0) this.append(new Float32Array(pad))
        await this.decodeReady()
      }
    }
    const text = (this.ended + this.phrase).replace(/^ /, '')
    this.reset()
    return text
  }

  reset() {
    this.model.reset()
    this.sampleBase = this.heard = 0
    this.frameBase = this.made = this.next = 0
    this.prev = -1
    this.outFrame = this.phraseStart = 0
    this.phrase = this.ended = ''
  }

  private append(pcm: Float32Array) {
    // Keep only what the next frame onward needs (under a frame's worth), then add these.
    const keepFrom = Math.max(this.sampleBase, NemoFeatures.firstSample(this.made))
    const kept = this.heard - keepFrom
    if (keepFrom > this.sampleBase) this.samples.copyWithin(0, keepFrom - this.sampleBase, this.heard - this.sampleBase)
    this.sampleBase = keepFrom
    if (kept + pcm.length > this.samples.length) {
      const bigger = new Float32Array(Math.max(this.samples.length * 2, kept + pcm.length))
      bigger.set(this.samples.subarray(0, kept))
      this.samples = bigger
    }
    this.samples.set(pcm, kept)
    this.heard += pcm.length
    // Every frame whose samples are all here now.
    const bins = this.bins
    while (NemoFeatures.endSample(this.made) <= this.heard) {
      let row = this.made - this.frameBase
      if ((row + 1) * bins > this.frames.length) {
        // Drop the frames the model has read past, or grow.
        const dropFrames = this.next - this.frameBase
        if (dropFrames > 0) {
          this.frames.copyWithin(0, dropFrames * bins, row * bins)
          this.frameBase = this.next
          row -= dropFrames
        }
        if ((row + 1) * bins > this.frames.length) {
          const bigger = new Float32Array(this.frames.length * 2)
          bigger.set(this.frames.subarray(0, row * bins))
          this.frames = bigger
        }
      }
      this.features.frameOf(this.samples, this.sampleBase, this.made, this.frames, row * bins, 1)
      this.made++
    }
  }

  private async decodeReady() {
    const { window, shift } = this.model
    const bins = this.bins
    while (this.next + window <= this.made) {
      // bins × window, bin-major, from the frame-major frames.
      const x = this.x
      const first = this.next - this.frameBase
      for (let t = 0; t < window; t++) {
        const row = (first + t) * bins
        for (let b = 0; b < bins; b++) x[b * window + t] = this.frames[row + b]
      }
      const { logprobs, frames } = await this.model.run(x)
      this.next += shift
      this.greedy(logprobs, frames)
    }
  }

  private greedy(lp: Float32Array, frames: number) {
    const vocab = lp.length / Math.max(1, frames)
    for (let t = 0; t < frames; t++, this.outFrame++) {
      let best = 0
      let max = -Infinity
      const row = t * vocab
      for (let k = 0; k < vocab; k++) {
        const v = lp[row + k]
        if (v > max) {
          max = v
          best = k
        }
      }
      if (best !== this.blank && best !== this.prev) {
        const p = this.pieces[best] ?? ''
        if (p !== '<unk>') {
          const word = p.startsWith('▁')
          // A long phrase ends where the next word starts (once per accept: another waits its turn).
          if (word && this.phrase && !this.ended && this.outFrame - this.phraseStart >= this.maxPhraseFrames) {
            this.ended = this.phrase
            this.phrase = ''
            this.phraseStart = this.outFrame
          }
          this.phrase += p.replace(/^▁/, ' ')
        }
      }
      this.prev = best
    }
  }
}
