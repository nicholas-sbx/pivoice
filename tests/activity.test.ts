import { describe, expect, it } from 'vitest'
import { ActivityTracker, AUDIBLE_RMS, SPEAKING_HOLD_MS, SPEAKING_RMS, sameActivity } from '../src/audio/activity'

describe('activity rings', () => {
  it('lights the thin ring for any sound and the full one for speech, each for a moment', () => {
    const t = new ActivityTracker()
    t.hear('quiet', AUDIBLE_RMS * 3, 0) // a room, a breath: about −70 dBFS
    t.hear('talking', SPEAKING_RMS * 5, 0)
    t.hear('silent', 0, 0)
    const a = t.read(10)
    expect([...a.audible].sort()).toEqual(['quiet', 'talking'])
    expect([...a.speaking]).toEqual(['talking'])
    // Held over the gaps between words, then let go.
    expect(t.read(SPEAKING_HOLD_MS - 1).audible.has('quiet')).toBe(true)
    expect(t.read(SPEAKING_HOLD_MS + 1).audible.size).toBe(0)
  })

  it('leaves out who it is told to, and forgets people', () => {
    const t = new ActivityTracker()
    t.hear('me', SPEAKING_RMS * 5, 0)
    t.hear('them', SPEAKING_RMS * 5, 0)
    expect([...t.read(1, id => id !== 'me').speaking]).toEqual(['them'])
    t.forget('them')
    expect(t.read(1).audible.has('them')).toBe(false)
  })

  it('only counts it as a change when someone’s ring changes', () => {
    const a = { speaking: new Set(['x']), audible: new Set(['x', 'y']) }
    expect(sameActivity(a, { speaking: new Set(['x']), audible: new Set(['y', 'x']) })).toBe(true)
    expect(sameActivity(a, { speaking: new Set(['x']), audible: new Set(['x']) })).toBe(false)
  })
})
