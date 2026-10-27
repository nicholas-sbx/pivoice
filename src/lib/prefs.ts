import type { SpatialMode } from '../audio/engine'

export interface Prefs {
  name: string
  spatial: SpatialMode
  /** What the spatial button in the call controls switches to. */
  lastSpatial: Exclude<SpatialMode, 'off'>
  inputId: string
  outputId: string
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
  /** Opus DTX for what people send you: less bandwidth in silence, ~9 ms more buffering. */
  dtx: boolean
}

const KEY = 'pv.prefs'

export const DEFAULT_PREFS: Prefs = {
  name: '',
  spatial: 'off',
  lastSpatial: 'hrtf',
  inputId: '',
  outputId: '',
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  showCode: false,
  showPing: true,
  showRoute: false,
  dtx: true
}

export function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>
    const p = { ...DEFAULT_PREFS }
    if (typeof raw.name === 'string') p.name = raw.name
    if (raw.spatial === 'off' || raw.spatial === 'stereo' || raw.spatial === 'hrtf') p.spatial = raw.spatial
    if (raw.lastSpatial === 'stereo' || raw.lastSpatial === 'hrtf') p.lastSpatial = raw.lastSpatial
    if (typeof raw.inputId === 'string') p.inputId = raw.inputId
    if (typeof raw.outputId === 'string') p.outputId = raw.outputId
    for (const k of ['echoCancellation', 'noiseSuppression', 'autoGainControl', 'showCode', 'showPing', 'showRoute', 'dtx'] as const) {
      if (typeof raw[k] === 'boolean') p[k] = raw[k]
    }
    return p
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* private mode or storage blocked: prefs just don't stick */
  }
}
