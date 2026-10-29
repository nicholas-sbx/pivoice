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

/** [echo cancellation, noise suppression, auto gain] */
const mic = (p: ReturnType<typeof loadPrefs>) => [p.echoCancellation, p.noiseSuppression, p.autoGainControl]

describe('mic processing defaults', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('has all three on for phones and tablets', () => {
    expect(mic(device({ userAgent: IPHONE }))).toEqual([true, true, true])
    expect(mic(device({ userAgent: ANDROID }))).toEqual([true, true, true])
    expect(mic(device(IPAD))).toEqual([true, true, true])
  })

  it('has only noise suppression on for a computer', () => {
    expect(mic(device({ userAgent: WINDOWS }))).toEqual([false, true, false])
    expect(mic(device({ userAgent: MAC }))).toEqual([false, true, false])
  })

  it('has the same defaults when nothing readable is saved', () => {
    vi.stubGlobal('localStorage', { getItem: () => '{not json', setItem: () => {} })
    vi.stubGlobal('navigator', { userAgent: IPHONE, maxTouchPoints: 5 })
    expect(mic(loadPrefs())).toEqual([true, true, true])
    vi.stubGlobal('navigator', { userAgent: WINDOWS, maxTouchPoints: 0 })
    expect(mic(loadPrefs())).toEqual([false, true, false])
  })

  it('ignores what a phone saved before the new defaults', () => {
    const old = { rev: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    expect(mic(device({ userAgent: IPHONE }, old))).toEqual([true, true, true])
    expect(mic(device({ userAgent: IPHONE }, { echoCancellation: false }))).toEqual([true, true, true])
  })

  it("ignores a computer's saved noise suppression from before it was on, but not the other two", () => {
    const old = { rev: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: true }
    expect(mic(device({ userAgent: WINDOWS }, old))).toEqual([true, true, true])
    expect(mic(device({ userAgent: WINDOWS }, { echoCancellation: false, noiseSuppression: false }))).toEqual([false, true, false])
  })

  it('keeps any choice made since', () => {
    const chosen = { rev: 2, echoCancellation: true, noiseSuppression: false, autoGainControl: true }
    expect(mic(device({ userAgent: IPHONE }, chosen))).toEqual([true, false, true])
    expect(mic(device({ userAgent: WINDOWS }, chosen))).toEqual([true, false, true])
    expect(mic(device({ userAgent: WINDOWS }, { rev: 2, echoCancellation: false, noiseSuppression: true, autoGainControl: false }))).toEqual([false, true, false])
  })

  it('still honours a DTX choice saved at rev 1', () => {
    expect(device({ userAgent: WINDOWS }, { rev: 1, dtx: true }).dtx).toBe(true)
    expect(device({ userAgent: WINDOWS }, { dtx: true }).dtx).toBe(false)
  })
})
