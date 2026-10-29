import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadPrefs } from '../src/lib/prefs'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const IPAD = { userAgent: MAC, maxTouchPoints: 5 }

function device(nav: { userAgent: string; maxTouchPoints?: number }, saved?: object) {
  vi.stubGlobal('navigator', { maxTouchPoints: 0, ...nav })
  vi.stubGlobal('localStorage', { getItem: () => (saved ? JSON.stringify(saved) : null), setItem: () => {} })
  return loadPrefs()
}

const mic = (p: ReturnType<typeof loadPrefs>) => [p.echoCancellation, p.noiseSuppression, p.autoGainControl]

describe('mic processing defaults', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is on for phones and tablets', () => {
    expect(mic(device({ userAgent: IPHONE }))).toEqual([true, true, true])
    expect(mic(device({ userAgent: ANDROID }))).toEqual([true, true, true])
    expect(mic(device(IPAD))).toEqual([true, true, true])
  })

  it('stays off on a computer', () => {
    expect(mic(device({ userAgent: WINDOWS }))).toEqual([false, false, false])
    expect(mic(device({ userAgent: MAC }))).toEqual([false, false, false])
  })

  it('is on for a phone with nothing readable saved', () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE, maxTouchPoints: 5 })
    vi.stubGlobal('localStorage', { getItem: () => '{not json', setItem: () => {} })
    expect(mic(loadPrefs())).toEqual([true, true, true])
  })

  it('ignores what a phone saved before they were on by default', () => {
    const old = { rev: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    expect(mic(device({ userAgent: IPHONE }, old))).toEqual([true, true, true])
    expect(mic(device({ userAgent: IPHONE }, { echoCancellation: false }))).toEqual([true, true, true])
  })

  it("keeps a phone's choice once it was made with them on by default", () => {
    const chosen = { rev: 2, echoCancellation: true, noiseSuppression: false, autoGainControl: true }
    expect(mic(device({ userAgent: IPHONE }, chosen))).toEqual([true, false, true])
  })

  it("keeps a computer's saved choice whatever its rev", () => {
    expect(mic(device({ userAgent: WINDOWS }, { rev: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: true }))).toEqual([true, false, true])
    expect(mic(device({ userAgent: WINDOWS }, { rev: 2, echoCancellation: false, noiseSuppression: true, autoGainControl: false }))).toEqual([false, true, false])
  })

  it('still honours a DTX choice saved at rev 1', () => {
    expect(device({ userAgent: WINDOWS }, { rev: 1, dtx: true }).dtx).toBe(true)
    expect(device({ userAgent: WINDOWS }, { dtx: true }).dtx).toBe(false)
  })
})
