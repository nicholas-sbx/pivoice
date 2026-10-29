import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PREFS, loadPrefs } from '../src/lib/prefs'

const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v)
  } as Storage
})

describe('overlay prefs', () => {
  it('starts off, top right', () => {
    expect(loadPrefs().overlay).toEqual(DEFAULT_PREFS.overlay)
    expect(DEFAULT_PREFS.overlay.on).toBe(false)
  })

  it('keeps what makes sense and drops the rest', () => {
    store.set('pv.prefs', JSON.stringify({ overlay: { on: true, monitor: 'Dell U2720Q', anchor: 'bottom-left', margin: 9999, size: 300, opacity: 'x' } }))
    expect(loadPrefs().overlay).toEqual({ ...DEFAULT_PREFS.overlay, on: true, monitor: 'Dell U2720Q', anchor: 'bottom-left', size: 300 })
    store.set('pv.prefs', JSON.stringify({ overlay: { anchor: 'somewhere' } }))
    expect(loadPrefs().overlay.anchor).toBe('top-right')
  })
})

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'

/** [echo cancellation, noise suppression, auto gain], on this device, with this saved. */
function mic(userAgent: string, saved?: object, maxTouchPoints = 0) {
  vi.stubGlobal('navigator', { userAgent, maxTouchPoints })
  if (saved) store.set('pv.prefs', JSON.stringify(saved))
  const p = loadPrefs()
  return [p.echoCancellation, p.noiseSuppression, p.autoGainControl]
}

describe('mic processing defaults', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('has noise suppression and auto gain on everywhere, echo cancellation only on phones and tablets', () => {
    expect(mic(WINDOWS)).toEqual([false, true, true])
    expect(mic(MAC)).toEqual([false, true, true])
    expect(mic(IPHONE)).toEqual([true, true, true])
    expect(mic(ANDROID)).toEqual([true, true, true])
    expect(mic(MAC, undefined, 5)).toEqual([true, true, true]) // an iPad
  })

  it('has the same defaults when nothing readable is saved', () => {
    store.set('pv.prefs', '{not json')
    expect(mic(IPHONE)).toEqual([true, true, true])
    expect(mic(WINDOWS)).toEqual([false, true, true])
  })

  it('ignores the offs saved before the new defaults, which were only the old defaults', () => {
    const old = { rev: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    expect(mic(WINDOWS, old)).toEqual([false, true, true])
    expect(mic(IPHONE, old)).toEqual([true, true, true])
    expect(mic(IPHONE, { echoCancellation: false })).toEqual([true, true, true])
  })

  it("keeps a computer's echo cancellation from before, whose default didn't change", () => {
    expect(mic(WINDOWS, { rev: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false })).toEqual([true, true, true])
  })

  it('keeps any choice made since', () => {
    expect(mic(IPHONE, { rev: 2, echoCancellation: false, noiseSuppression: false, autoGainControl: true })).toEqual([false, false, true])
    expect(mic(WINDOWS, { rev: 2, echoCancellation: true, noiseSuppression: true, autoGainControl: false })).toEqual([true, true, false])
  })

  it('still honours a DTX choice saved at rev 1', () => {
    store.set('pv.prefs', JSON.stringify({ rev: 1, dtx: true }))
    expect(loadPrefs().dtx).toBe(true)
    store.set('pv.prefs', JSON.stringify({ dtx: true }))
    expect(loadPrefs().dtx).toBe(false)
  })
})
