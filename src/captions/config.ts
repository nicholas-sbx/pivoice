import { DEFAULT_MODEL, isModelId, type ModelId } from './models'

/**
 * Live captions: everyone captions themselves, on their own machine, and
 * sends the words to everyone else over the peer connection. Nothing is
 * transcribed while you're not talking (no full green ring), and nothing
 * leaves your machine but text.
 *
 * Three recognisers (models.ts): Vosk (Kaldi, streaming), the default;
 * Parakeet (NVIDIA NeMo, a phrase at a time, with punctuation); and
 * FastConformer (NVIDIA NeMo, streaming, lowercase). All run on the CPU, nothing
 * needs a GPU. In a browser they're WebAssembly in a worker (worker-core.ts);
 * in the app, the libraries themselves in a process of their own
 * (native/internal/asr). Either way it hears your mic before noise
 * suppression and gain, the browser's or the app's, so it gets as much of your voice as
 * there is (echo cancellation is the one exception: on speakers, the raw
 * mic would hear everyone else), but only between the ring lighting and
 * going out, plus a little either side (the pre-roll and post-roll below).
 * That's for the CPU as much as for privacy: outside those, the recogniser
 * is given nothing and does nothing.
 *
 * These are the settings, all live.
 */

/**
 * When the model may be downloaded without asking: on anything but mobile
 * data (`wifi`), never (`ask`), or always (`always`).
 */
export type DownloadPolicy = 'wifi' | 'ask' | 'always'

/**
 * What the recogniser hears in a browser: the mic with none of the
 * browser's noise suppression or auto gain (`raw`; with echo cancellation
 * if the call has it on, see AudioEngine.captionSources), from a capture of
 * its own where the call's isn't that already; or the call's own capture,
 * processed as the call hears it (`call`). The app always does the first,
 * itself (internal/engine/captions.go).
 */
export type CaptionSource = 'raw' | 'call'

export interface CaptionPrefs {
  /** Caption your own voice and send the words to everyone. */
  send: boolean
  /** Which recogniser (models.ts). */
  model: ModelId
  /** Show everyone else's captions. */
  show: boolean
  /** Show your own captions too, beside you, as everyone else sees them. */
  showOwn: boolean
  download: DownloadPolicy
  source: CaptionSource
  /** How much audio from before the ring lit goes in first, ms (it's kept all the time, and recognised in a burst). */
  preRollMs: number
  /** How long it keeps listening after the ring goes out, ms. */
  postRollMs: number
  /** Send words as they're recognised (and corrected), or only whole phrases. */
  partials: boolean
  /** Vosk and FastConformer: the most live updates a second (each is cheap). */
  partialsPerSec: number
  /** Parakeet: read the phrase so far again this often, ms of speech (each read is the whole phrase again, so this is most of what it costs). */
  rereadMs: number
  /**
   * A phrase this long is finished and a new one started, s. Parakeet: there
   * (it's recognised whole, so long ones cost more). FastConformer: at the
   * next word, the model carrying straight on (so captions stay a size to read).
   */
  maxPhraseSec: number
  /** Vosk: leave out words it's less sure of than this (0–1; 0 keeps everything). Finished phrases only. */
  minConfidence: number
  /** The app: CPU threads the recogniser may use (a browser always uses one). */
  threads: number
  /** How long a caption stays up after its last word, s. */
  lingerSec: number
  /** How many lines of someone's captions show at once. */
  lines: number
  /** How much each older phrase fades, per phrase back (0 is no fading). */
  fade: number
  /** Blink a caret after their words while they're still speaking. */
  caret: boolean
  /** Caption text size. */
  scale: number
}

export const CAPTION_DEFAULTS: CaptionPrefs = {
  send: true,
  model: DEFAULT_MODEL,
  show: true,
  showOwn: true,
  download: 'wifi',
  source: 'raw',
  preRollMs: 200,
  postRollMs: 200,
  partials: true,
  partialsPerSec: 8,
  rereadMs: 1000,
  maxPhraseSec: 15,
  minConfidence: 0,
  threads: 2,
  lingerSec: 6,
  lines: 3,
  fade: 0.25,
  caret: true,
  scale: 1
}

/** [min, max, step] for each numeric setting. */
export const CAPTION_RANGES = {
  preRollMs: [0, 1000, 50],
  postRollMs: [0, 2000, 50],
  partialsPerSec: [1, 20, 1],
  rereadMs: [250, 4000, 250],
  maxPhraseSec: [4, 30, 1],
  minConfidence: [0, 0.95, 0.05],
  threads: [1, 8, 1],
  lingerSec: [1, 20, 1],
  lines: [1, 6, 1],
  fade: [0, 0.8, 0.05],
  scale: [0.75, 1.5, 0.05]
} as const satisfies Partial<Record<keyof CaptionPrefs, readonly [number, number, number]>>

/** The longest pre-roll there's room for (the gate's buffer is made this big, once). */
export const MAX_PRE_ROLL_MS = CAPTION_RANGES.preRollMs[1]

export function captionDefaults(): CaptionPrefs {
  return { ...CAPTION_DEFAULTS }
}

export function sanitizeCaptions(raw: unknown): CaptionPrefs {
  const c = captionDefaults()
  if (!raw || typeof raw !== 'object') return c
  const r = raw as Record<string, unknown>
  for (const k of ['send', 'show', 'showOwn', 'partials', 'caret'] as const) if (typeof r[k] === 'boolean') c[k] = r[k]
  if (r.download === 'wifi' || r.download === 'ask' || r.download === 'always') c.download = r.download
  if (r.source === 'raw' || r.source === 'call') c.source = r.source
  if (isModelId(r.model)) c.model = r.model
  for (const [k, [min, max]] of Object.entries(CAPTION_RANGES) as [keyof typeof CAPTION_RANGES, readonly [number, number, number]][]) {
    const v = r[k]
    if (typeof v === 'number' && Number.isFinite(v)) c[k] = Math.min(max, Math.max(min, v))
  }
  c.lines = Math.round(c.lines)
  c.threads = Math.round(c.threads)
  return c
}

/** What the recognisers are fed: the models' own rate. */
export const CAPTION_RATE = 16_000
