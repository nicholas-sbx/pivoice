/**
 * Settings for the low-latency engine, which carries everyone's voice.
 * Sending settings shape what you send; receiving settings shape your
 * jitter buffer. All of them apply live.
 */

/** The pretend person the mic test's packets come back from (see worker.ts). */
export const LOOP_ID = '__loop'

/**
 * Everyone sends raw 16-bit PCM, one 128-sample render quantum (2.7 ms) a
 * packet: no encoder, no lookahead, about 0.8 Mbit/s to each listener. No
 * codec at all, so nothing that reads what others send is C (see the
 * README, "Why no Opus").
 */
export const PCM_FRAME = 128

/** The fixed cost of the sending side: the block you wait to fill. */
export const SEND_DELAY_MS = (PCM_FRAME * 1000) / 48_000

/**
 * Bumped when the defaults change for a reason that should reach people
 * who already have settings saved. 2: the silence gate stopped chopping
 * quiet speech (−70 dBFS, 400 ms hangover) and the jitter target moved to
 * the 99th percentile. 3: raw PCM became the default codec, and the engine
 * is on by default. 4: in a browser it's off by default again (the app
 * keeps it on); tuning carried over. 5: on in a browser again, and
 * redundancy and silence suppression went off by default, for everyone.
 * 6: Opus went, and with it the switch: the engine is the only way;
 * tuning carried over.
 */
export const LL_REV = 6
/** Saved tuning from before this resets to the defaults, once. */
const TUNING_SINCE = 5

export interface LLConfig {
  rev: number
  // Sending
  /** Send nothing while you're quiet (our own silence gate). */
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

/** The defaults, the same in the app and in a browser. */
export const LL_DEFAULTS: LLConfig = {
  rev: LL_REV,
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

export function llDefaults(): LLConfig {
  return { ...LL_DEFAULTS }
}

export function sanitizeLL(raw: unknown): LLConfig {
  const c = llDefaults()
  if (!raw || typeof raw !== 'object') return c
  const r = raw as Record<string, unknown>
  const rev = typeof r.rev === 'number' ? r.rev : 0
  if (rev < TUNING_SINCE || rev > LL_REV) return c
  if (typeof r.dtx === 'boolean') c.dtx = r.dtx
  if (r.redundancy === 0 || r.redundancy === 1 || r.redundancy === 2) c.redundancy = r.redundancy
  for (const [k, [min, max]] of Object.entries(LL_RANGES) as [keyof typeof LL_RANGES, readonly [number, number, number]][]) {
    const v = r[k]
    if (typeof v === 'number' && Number.isFinite(v)) c[k] = Math.min(max, Math.max(min, v))
  }
  if (c.maxBufferMs < c.minBufferMs) c.maxBufferMs = c.minBufferMs
  return c
}
