/**
 * Settings for the experimental low-latency engine. Sending settings shape
 * what you send; receiving settings shape your jitter buffer. All of them
 * apply live.
 */

export type FrameMs = 2.5 | 5 | 10 | 20

/** The pretend person the mic test's packets come back from (see worker.ts). */
export const LOOP_ID = '__loop'
export type OpusApplication = 'lowdelay' | 'voip' | 'audio'
/**
 * Opus, or raw 16-bit PCM: no encoder, no lookahead, one 128-sample render
 * quantum (2.7 ms) per packet, about 0.8 Mbit/s a listener. For local networks.
 */
export type LLCodec = 'opus' | 'pcm'

/** PCM goes out one render quantum at a time. */
export const PCM_FRAME = 128

/**
 * Bumped when the defaults change for a reason that should reach people
 * who already have settings saved. 2: the silence gate stopped chopping
 * quiet speech (−70 dBFS, 400 ms hangover) and the jitter target moved to
 * the 99th percentile. 3: raw PCM became the default codec, and the engine
 * is on by default. 4: in a browser it's off by default again (the app
 * keeps it on); tuning carried over. 5: on in a browser again, and
 * redundancy and silence suppression went off by default, for everyone.
 */
export const LL_REV = 5
/** Saved tuning from before this resets to the defaults, once. */
const TUNING_SINCE = 5
/**
 * Whether the engine is on survives a revision, except across these: it
 * was saved for everyone as whatever the default was, so a saved `enabled`
 * from before the default changed was never anyone's choice.
 */
const ENABLED_SINCE = { app: 3, web: 5 }

export interface LLConfig {
  rev: number
  enabled: boolean
  // Sending
  codec: LLCodec
  frameMs: FrameMs
  application: OpusApplication
  bitrateKbps: number
  complexity: number
  /** Send nothing while you're quiet (our own gate; see engine.ts for why not Opus's). */
  dtx: boolean
  /** Frames quieter than this (RMS, dBFS) count as silence for `dtx`. */
  dtxThresholdDb: number
  /** Keep sending this long after you go quiet, so the ends of words (and quiet bits mid-sentence) get through. */
  dtxHangoverMs: number
  /** How many previous frames each packet repeats, so one lost packet is recovered from the next. */
  redundancy: 0 | 1 | 2
  // Receiving (jitter buffer)
  minBufferMs: number
  maxBufferMs: number
  /** Added on top of the measured jitter. */
  marginMs: number
  /** Measured jitter is multiplied by this. */
  jitterMultiplier: number
  /** Which percentile of recent lateness counts as "the jitter". 100 is the worst seen. */
  jitterPercentile: number
  /** How far back the jitter measurement looks, seconds. */
  jitterWindowSec: number
  /** Most the playback speed may change to steer toward the target, %. 0 turns it off. */
  stretchPct: number
  /** How long a gap is papered over (fading the last frame) before it goes silent. */
  concealMs: number
}

export const FRAME_OPTIONS: FrameMs[] = [2.5, 5, 10, 20]
export const APPLICATIONS: OpusApplication[] = ['lowdelay', 'voip', 'audio']

/** The app's defaults (see llDefaults). */
export const LL_DEFAULTS: LLConfig = {
  rev: LL_REV,
  enabled: true,
  codec: 'pcm',
  frameMs: 5,
  application: 'lowdelay',
  bitrateKbps: 64,
  complexity: 8,
  dtx: false,
  dtxThresholdDb: -70,
  dtxHangoverMs: 400,
  redundancy: 0,
  minBufferMs: 0,
  maxBufferMs: 80,
  marginMs: 3,
  jitterMultiplier: 1,
  jitterPercentile: 99,
  jitterWindowSec: 3,
  stretchPct: 2,
  concealMs: 12
}

/** Number limits for each numeric setting: [min, max, step]. */
export const LL_RANGES = {
  bitrateKbps: [12, 256, 4],
  complexity: [0, 10, 1],
  dtxThresholdDb: [-90, -30, 1],
  dtxHangoverMs: [50, 1500, 50],
  jitterPercentile: [80, 100, 1],
  jitterWindowSec: [1, 10, 1],
  minBufferMs: [0, 60, 1],
  maxBufferMs: [10, 300, 5],
  marginMs: [0, 30, 1],
  jitterMultiplier: [0.5, 3, 0.1],
  stretchPct: [0, 6, 0.5],
  concealMs: [0, 60, 1]
} as const satisfies Partial<Record<keyof LLConfig, readonly [number, number, number]>>

/** The defaults: the same in the app and in a browser (the engine on, raw PCM, no redundancy, no silence suppression). */
export function llDefaults(_app: boolean): LLConfig {
  return { ...LL_DEFAULTS }
}

export function sanitizeLL(raw: unknown, app: boolean): LLConfig {
  const c = llDefaults(app)
  if (!raw || typeof raw !== 'object') return c
  const r = raw as Record<string, unknown>
  const rev = typeof r.rev === 'number' ? r.rev : 0
  if (typeof r.enabled === 'boolean' && rev >= ENABLED_SINCE[app ? 'app' : 'web']) c.enabled = r.enabled
  if (rev < TUNING_SINCE || rev > LL_REV) return c
  if (typeof r.dtx === 'boolean') c.dtx = r.dtx
  if (FRAME_OPTIONS.includes(r.frameMs as FrameMs)) c.frameMs = r.frameMs as FrameMs
  if (APPLICATIONS.includes(r.application as OpusApplication)) c.application = r.application as OpusApplication
  if (r.codec === 'opus' || r.codec === 'pcm') c.codec = r.codec
  if (r.redundancy === 0 || r.redundancy === 1 || r.redundancy === 2) c.redundancy = r.redundancy
  for (const [k, [min, max]] of Object.entries(LL_RANGES) as [keyof typeof LL_RANGES, readonly [number, number, number]][]) {
    const v = r[k]
    if (typeof v === 'number' && Number.isFinite(v)) c[k] = Math.min(max, Math.max(min, v))
  }
  if (c.maxBufferMs < c.minBufferMs) c.maxBufferMs = c.minBufferMs
  return c
}

/** Frame length in samples at 48 kHz. */
export function frameSamples(ms: FrameMs): number {
  return Math.round(ms * 48)
}

/** What the capture worklet should cut the mic into for this config. */
export function captureFrame(cfg: Pick<LLConfig, 'codec' | 'frameMs'>): number {
  return cfg.codec === 'pcm' ? PCM_FRAME : frameSamples(cfg.frameMs)
}

/** The fixed cost of the sending side: the frame you wait to fill, plus the encoder's lookahead. */
export function sendDelayMs(cfg: Pick<LLConfig, 'codec' | 'frameMs' | 'application'>): number {
  return cfg.codec === 'pcm' ? (PCM_FRAME * 1000) / 48_000 : cfg.frameMs + lookaheadMs(cfg.application)
}

/** Opus lookahead for each mode: low delay is CELT only, 2.5 ms; the others 6.5 ms. */
export function lookaheadMs(app: OpusApplication): number {
  return app === 'lowdelay' ? 2.5 : 6.5
}
