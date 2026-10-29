import type { OutputBuffer, SpatialMode } from '../audio/engine'
import { llDefaults, sanitizeLL, type LLConfig } from '../audio/ll/config'
import { isNative } from '../native/bridge'
import { onMobileDevice } from '../native/downloads'

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
  /** The app on Windows: WASAPI exclusive mode (smallest buffers; nothing else can play meanwhile). */
  appExclusive: boolean
  // Noise suppression and auto gain are on by default. Echo cancellation is
  // off on a computer, where it adds latency and everyone's on headphones,
  // and on for a phone (MOBILE_MIC), held at arm's length on the speaker,
  // where the speaker feeds back.
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
  /**
   * The app's noise suppression gate: RNNoise's voice probability below
   * which you're faded out (0 is no gate), once noiseGraceMs has passed
   * since the last voice. Set low and long, so words aren't clipped.
   */
  noiseGate: number
  noiseGraceMs: number
  /** RNNoise's lookahead: off by default, since it's 10 ms more delay. */
  noiseLookahead: boolean
  /** The app's automatic gain: the level it brings you to (dBFS RMS), and the most it may boost a quiet mic (dB). */
  agcTargetDb: number
  agcMaxDb: number
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
 * 2: noise suppression and auto gain went on by default everywhere, and echo
 * cancellation on phones, so what was saved before doesn't count for those.
 */
const PREFS_REV = 2

/** What a phone starts with on top of everyone's defaults (see Prefs). */
const MOBILE_MIC = { echoCancellation: true } as const

export const DEFAULT_PREFS: Prefs = {
  rev: PREFS_REV,
  name: '',
  spatial: 'off',
  lastSpatial: 'hrtf',
  inputId: '',
  outputId: '',
  appInputId: '',
  appOutputId: '',
  appExclusive: false,
  echoCancellation: false,
  noiseSuppression: true,
  autoGainControl: true,
  noiseGate: 0.4,
  noiseGraceMs: 400,
  noiseLookahead: false,
  agcTargetDb: -16,
  agcMaxDb: 30,
  showCode: false,
  showPing: true,
  showRoute: false,
  dtx: false,
  outputBuffer: 'min',
  ll: llDefaults(isNative)
}

export function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>
    const mobile = onMobileDevice()
    const savedRev = typeof raw.rev === 'number' ? raw.rev : 0
    const p = { ...DEFAULT_PREFS, ...(mobile ? MOBILE_MIC : {}), ll: sanitizeLL(raw.ll, isNative) }
    if (typeof raw.name === 'string') p.name = raw.name
    if (raw.spatial === 'off' || raw.spatial === 'stereo' || raw.spatial === 'hrtf') p.spatial = raw.spatial
    if (raw.lastSpatial === 'stereo' || raw.lastSpatial === 'hrtf') p.lastSpatial = raw.lastSpatial
    if (typeof raw.inputId === 'string') p.inputId = raw.inputId
    if (raw.outputBuffer === 'min' || raw.outputBuffer === 'small' || raw.outputBuffer === 'interactive') p.outputBuffer = raw.outputBuffer
    if (typeof raw.outputId === 'string') p.outputId = raw.outputId
    if (typeof raw.appInputId === 'string') p.appInputId = raw.appInputId
    if (typeof raw.appOutputId === 'string') p.appOutputId = raw.appOutputId
    if (typeof raw.noiseGate === 'number' && raw.noiseGate >= 0 && raw.noiseGate <= 1) p.noiseGate = raw.noiseGate
    if (typeof raw.noiseGraceMs === 'number' && raw.noiseGraceMs >= 0 && raw.noiseGraceMs <= 2000) p.noiseGraceMs = raw.noiseGraceMs
    if (typeof raw.agcTargetDb === 'number' && raw.agcTargetDb >= -30 && raw.agcTargetDb <= -6) p.agcTargetDb = raw.agcTargetDb
    if (typeof raw.agcMaxDb === 'number' && raw.agcMaxDb >= 0 && raw.agcMaxDb <= 40) p.agcMaxDb = raw.agcMaxDb
    for (const k of ['appExclusive', 'noiseLookahead', 'showCode', 'showPing', 'showRoute'] as const) {
      if (typeof raw[k] === 'boolean') p[k] = raw[k]
    }
    // A saved choice only counts if it was made once the default it overrides was in place.
    for (const k of ['noiseSuppression', 'autoGainControl'] as const) {
      if (savedRev >= 2 && typeof raw[k] === 'boolean') p[k] = raw[k]
    }
    if ((!mobile || savedRev >= 2) && typeof raw.echoCancellation === 'boolean') p.echoCancellation = raw.echoCancellation
    if (typeof raw.dtx === 'boolean' && savedRev >= 1) p.dtx = raw.dtx
    return p
  } catch {
    return { ...DEFAULT_PREFS, ...(onMobileDevice() ? MOBILE_MIC : {}), ll: llDefaults(isNative) }
  }
}

export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* private mode or storage blocked: prefs just don't stick */
  }
}
