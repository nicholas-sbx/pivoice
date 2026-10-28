import type { OutputBuffer, SpatialMode } from '../audio/engine'
import { LL_DEFAULTS, sanitizeLL, type LLConfig } from '../audio/ll/config'

export interface Prefs {
  /** See PREFS_REV. */
  rev: number
  name: string
  spatial: SpatialMode
  /** What the spatial button in the call controls switches to. */
  lastSpatial: Exclude<SpatialMode, 'off'>
  inputId: string
  outputId: string
  /** The same, in the app (its devices aren't the browser's). */
  appInputId: string
  appOutputId: string
  // All off by default: they each add latency, and everyone's on headphones.
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
  /** The room code is hidden until you ask to see it (screen sharing, streaming). */
  showCode: boolean
  /** Ping beside everyone's name. */
  showPing: boolean
  /** A card under everyone with the route their audio takes and what it's costing. */
  showRoute: boolean
  /** Opus DTX for what people send you: less bandwidth in silence, ~9 ms more buffering. Off by default. */
  dtx: boolean
  /**
   * Web Audio's output buffer. 'min' asks for the smallest the device will
   * do (128 frames, 2.7 ms): far less output delay, and the audio thread
   * runs every 2.7 ms instead of in ~10 ms bursts, which is also most of
   * the low-latency engine's capture jitter. 'interactive' is the browser's
   * default, for machines that crackle on 'min'.
   */
  outputBuffer: OutputBuffer
  /** The experimental low-latency engine and all its knobs. */
  ll: LLConfig
}

const KEY = 'pv.prefs'
/**
 * Bumped when a default changes for everyone who already has prefs saved
 * (which is everyone who's been in a call: all of them are saved). 1: DTX
 * went from on to off by default, so a saved `dtx` from before doesn't count.
 */
const PREFS_REV = 1

export const DEFAULT_PREFS: Prefs = {
  rev: PREFS_REV,
  name: '',
  spatial: 'off',
  lastSpatial: 'hrtf',
  inputId: '',
  outputId: '',
  appInputId: '',
  appOutputId: '',
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  showCode: false,
  showPing: true,
  showRoute: false,
  dtx: false,
  outputBuffer: 'min',
  ll: LL_DEFAULTS
}

export function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>
    const p = { ...DEFAULT_PREFS, ll: sanitizeLL(raw.ll) }
    if (typeof raw.name === 'string') p.name = raw.name
    if (raw.spatial === 'off' || raw.spatial === 'stereo' || raw.spatial === 'hrtf') p.spatial = raw.spatial
    if (raw.lastSpatial === 'stereo' || raw.lastSpatial === 'hrtf') p.lastSpatial = raw.lastSpatial
    if (typeof raw.inputId === 'string') p.inputId = raw.inputId
    if (raw.outputBuffer === 'min' || raw.outputBuffer === 'small' || raw.outputBuffer === 'interactive') p.outputBuffer = raw.outputBuffer
    if (typeof raw.outputId === 'string') p.outputId = raw.outputId
    if (typeof raw.appInputId === 'string') p.appInputId = raw.appInputId
    if (typeof raw.appOutputId === 'string') p.appOutputId = raw.appOutputId
    for (const k of ['echoCancellation', 'noiseSuppression', 'autoGainControl', 'showCode', 'showPing', 'showRoute'] as const) {
      if (typeof raw[k] === 'boolean') p[k] = raw[k]
    }
    if (typeof raw.dtx === 'boolean' && raw.rev === PREFS_REV) p.dtx = raw.dtx
    return p
  } catch {
    return { ...DEFAULT_PREFS, ll: { ...LL_DEFAULTS } }
  }
}

export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* private mode or storage blocked: prefs just don't stick */
  }
}
