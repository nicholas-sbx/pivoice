import { beforeEach, describe, expect, it } from 'vitest'
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
