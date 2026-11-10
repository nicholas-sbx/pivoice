/** Local presentation only; these settings never restart a recogniser. */
export interface CaptionFirstPrefs {
  on: boolean
  layout: 'overlay' | 'sidebar'
  mergeSec: number
  waitSec: number
  history: number
  scale: number
  spacing: number
  tint: boolean
  indicator: boolean
  dim: number
  blur: number
}

export const CAPTION_FIRST_DEFAULTS: CaptionFirstPrefs = {
  on: false,
  layout: 'overlay',
  mergeSec: 10,
  waitSec: 5,
  history: 100,
  scale: 1,
  spacing: 8,
  tint: true,
  indicator: true,
  dim: 0.65,
  blur: 8
}

export const CAPTION_FIRST_RANGES = {
  mergeSec: [0, 30, 1],
  waitSec: [1, 15, 1],
  history: [20, 300, 10],
  scale: [0.75, 1.75, 0.05],
  spacing: [0, 20, 1],
  dim: [0.2, 0.95, 0.05],
  blur: [0, 20, 1]
} as const

export function captionFirstDefaults(): CaptionFirstPrefs {
  return { ...CAPTION_FIRST_DEFAULTS }
}

export function sanitizeCaptionFirst(raw: unknown): CaptionFirstPrefs {
  const p = captionFirstDefaults()
  if (!raw || typeof raw !== 'object') return p
  const r = raw as Record<string, unknown>
  for (const k of ['on', 'tint', 'indicator'] as const) if (typeof r[k] === 'boolean') p[k] = r[k]
  if (r.layout === 'overlay' || r.layout === 'sidebar') p.layout = r.layout
  for (const k of Object.keys(CAPTION_FIRST_RANGES) as (keyof typeof CAPTION_FIRST_RANGES)[]) {
    const v = r[k]
    const [min, max] = CAPTION_FIRST_RANGES[k]
    if (typeof v === 'number' && Number.isFinite(v)) p[k] = Math.max(min, Math.min(max, v))
  }
  p.history = Math.round(p.history)
  return p
}
