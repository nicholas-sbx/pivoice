import { describe, expect, it } from 'vitest'
import { CaptionConversation } from '../src/captions/conversation'
import { CAPTION_FIRST_DEFAULTS, sanitizeCaptionFirst } from '../src/captions/conversation-config'
import { loadPrefs } from '../src/lib/prefs'
import { reactive } from 'vue'

const members = [
  { id: 'a', name: 'Alice', joinedAt: 1 },
  { id: 'b', name: 'Bob', joinedAt: 2 },
  { id: 'c', name: 'Cara', joinedAt: 3 }
]
function setup() {
  const c = new CaptionConversation()
  c.roster(members)
  return c
}
const activity = (c: Pick<CaptionConversation, 'activity'>, now: number, ...ids: string[]) => c.activity(new Set(ids), now)
const words = (c: Pick<CaptionConversation, 'apply'>, id: string, u: number, text: string, final: boolean, now: number, s = 1) => c.apply(id, { s, u, t: text, f: final }, now)

describe('transcript conversation', () => {
  it('keeps the same row when wrapped in the UI’s reactive state', () => {
    const c = reactive(setup())
    activity(c, 0, 'a')
    words(c, 'a', 0, 'first', true, 10)
    activity(c, 20)
    activity(c, 30, 'a')
    words(c, 'a', 1, 'second', true, 40)
    expect(c.visibleMessages.map(m => m.text)).toEqual(['first second'])
  })
  it('keeps an empty speech reservation out of the messages and moves typing into the first real text', () => {
    const c = setup()
    activity(c, 0, 'a')
    const id = c.messages[0]!.id
    expect(c.messages[0]).toMatchObject({ text: '', waiting: true, name: 'Alice' })
    expect(c.visibleMessages).toEqual([])
    expect(c.pendingSpeakers.map(p => p.id)).toEqual(['a'])
    words(c, 'a', 0, 'the cat', false, 50)
    expect(c.pendingSpeakers).toEqual([])
    expect(c.visibleMessages[0]).toMatchObject({ id, text: 'the cat', waiting: true })
    words(c, 'a', 0, 'the caption', false, 100)
    words(c, 'a', 0, 'the captions', true, 150)
    expect(c.messages).toHaveLength(1)
    expect(c.messages[0]).toMatchObject({ id, text: 'the captions' })
    expect(c.messages[0]!.waiting).toBe(false)
  })

  it('appends after a pause of at most ten seconds with nobody in between', () => {
    const c = setup()
    activity(c, 0, 'a')
    words(c, 'a', 0, 'hello', true, 100)
    activity(c, 200)
    activity(c, 10_200, 'a')
    words(c, 'a', 1, 'again', true, 10_300)
    expect(c.messages.map(m => m.text)).toEqual(['hello again'])
  })

  it('starts a new message after ten seconds, measured from stopping, not a delayed final', () => {
    const c = setup()
    activity(c, 0, 'a')
    words(c, 'a', 0, 'hello', false, 10)
    activity(c, 100)
    words(c, 'a', 0, 'hello there', true, 5000)
    activity(c, 10_101, 'a')
    words(c, 'a', 1, 'again', true, 10_200)
    expect(c.messages.map(m => m.text)).toEqual(['hello there', 'again'])
  })

  it('interleaves on speech starts even before the interrupter has any text', () => {
    const c = setup()
    activity(c, 0, 'a')
    words(c, 'a', 0, 'first', false, 20)
    activity(c, 100)
    activity(c, 200, 'b')
    activity(c, 300, 'a', 'b')
    words(c, 'a', 0, 'first corrected', true, 350)
    words(c, 'b', 0, 'between', true, 400)
    words(c, 'a', 1, 'last', true, 450)
    expect(c.messages.map(m => [m.name, m.text])).toEqual([['Alice', 'first corrected'], ['Bob', 'between'], ['Alice', 'last']])
  })

  it('keeps simultaneous speakers in their own rows, including late finals', () => {
    const c = setup()
    activity(c, 0, 'a')
    words(c, 'a', 0, 'one', false, 10)
    activity(c, 20, 'a', 'b')
    words(c, 'b', 0, 'two', false, 30)
    words(c, 'a', 0, 'one final', true, 40)
    words(c, 'a', 1, 'continued', false, 50)
    expect(c.messages.map(m => m.text)).toEqual(['one final continued', 'two'])
  })

  it('can disable merging and tune the pause window', () => {
    for (const mergeMs of [0, 500]) {
      const c = setup()
      c.mergeMs = mergeMs
      activity(c, 0, 'a')
      words(c, 'a', 0, 'one', true, 10)
      activity(c, 20)
      activity(c, 600, 'a')
      words(c, 'a', 1, 'two', true, 610)
      expect(c.messages.map(m => m.text)).toEqual(['one', 'two'])
    }
  })

  it('handles final-only caption senders without speaking observations', () => {
    const c = setup()
    words(c, 'a', 0, 'hello', true, 100)
    words(c, 'a', 1, 'again', true, 1000)
    words(c, 'b', 0, 'hi', true, 2000)
    words(c, 'a', 2, 'next', true, 3000)
    expect(c.messages.map(m => m.text)).toEqual(['hello again', 'hi', 'next'])
  })

  it('lets a delayed first result fill its reserved row after another person speaks', () => {
    const c = setup()
    activity(c, 0, 'a')
    activity(c, 100)
    activity(c, 200, 'b')
    words(c, 'b', 0, 'second', true, 300)
    words(c, 'a', 0, 'first', true, 400)
    expect(c.messages.map(m => m.text)).toEqual(['first', 'second'])
  })

  it('ends waiting and removes wordless placeholders after the grace period', () => {
    const c = setup()
    c.waitMs = 1000
    activity(c, 0, 'a', 'b')
    words(c, 'a', 0, 'kept', false, 100)
    activity(c, 200)
    c.tick(1199)
    expect(c.messages.every(m => m.waiting)).toBe(true)
    c.tick(1200)
    expect(c.visibleMessages.map(m => [m.text, m.waiting])).toEqual([['kept', false]])
  })

  it('keeps waiting during speech and accepts words after waiting timed out', () => {
    const c = setup()
    activity(c, 0, 'a')
    c.tick(60_000)
    expect(c.messages[0]!.waiting).toBe(true)
    words(c, 'a', 0, 'late', false, 60_010)
    activity(c, 60_100)
    c.tick(70_000)
    words(c, 'a', 0, 'late final', true, 80_000)
    expect(c.messages.map(m => m.text)).toEqual(['late final'])
  })

  it('keeps a timed-out empty reservation in order for a slow final-only result', () => {
    const c = setup()
    activity(c, 0, 'a')
    activity(c, 100)
    activity(c, 200, 'b')
    words(c, 'b', 0, 'second', true, 300)
    c.tick(6000)
    expect(c.visibleMessages.map(m => m.text)).toEqual(['second'])
    words(c, 'a', 0, 'first', true, 10_000)
    expect(c.visibleMessages.map(m => m.text)).toEqual(['first', 'second'])
  })

  it('fills an earlier unrecognised turn before a returning speaker’s new turn', () => {
    const c = setup()
    activity(c, 0, 'a')
    activity(c, 100, 'b')
    activity(c, 200, 'a')
    words(c, 'a', 0, 'before the interruption', true, 300)
    words(c, 'b', 0, 'interruption', true, 400)
    words(c, 'a', 1, 'after the interruption', true, 500)
    expect(c.messages.map(m => m.text)).toEqual(['before the interruption', 'interruption', 'after the interruption'])
  })

  it('has only one typing location per person, even while older results arrive late', () => {
    const c = setup()
    activity(c, 0, 'a')
    words(c, 'a', 0, 'old live words', false, 10)
    activity(c, 100, 'b')
    words(c, 'b', 0, 'interruption', false, 110)
    activity(c, 200, 'a', 'b')
    expect(c.visibleMessages.filter(m => m.speaker === 'a' && m.waiting)).toEqual([])
    expect(c.pendingSpeakers.map(p => p.id)).toEqual(['a'])
    words(c, 'a', 0, 'old corrected words', false, 210)
    expect(c.visibleMessages.filter(m => m.speaker === 'a' && m.waiting)).toEqual([])
    expect(c.pendingSpeakers.map(p => p.id)).toEqual(['a'])
    words(c, 'a', 0, 'old final words', true, 220)
    expect(c.pendingSpeakers.map(p => p.id)).toEqual(['a'])
    words(c, 'a', 1, 'new live words', false, 230)
    expect(c.pendingSpeakers).toEqual([])
    expect(c.visibleMessages.filter(m => m.speaker === 'a' && m.waiting).map(m => m.text)).toEqual(['new live words'])
    words(c, 'a', 1, 'new final words', true, 240)
    expect(c.visibleMessages.filter(m => m.speaker === 'a' && m.waiting)).toEqual([])
  })

  it('removes a provisional message when its final caption is empty, including during the ring hold', () => {
    const c = setup()
    activity(c, 0, 'a')
    words(c, 'a', 0, 'hallucinated words', false, 10)
    expect(c.visibleMessages).toHaveLength(1)
    words(c, 'a', 0, '', true, 20)
    expect(c.visibleMessages).toEqual([])
    expect(c.pendingSpeakers).toEqual([])
    activity(c, 100)
    c.tick(200)
    expect(c.visibleMessages).toEqual([])
    expect(c.pendingSpeakers).toEqual([])
  })

  it('removes only the rejected phrase when an empty final belongs to an appended message', () => {
    const c = setup()
    activity(c, 0, 'a')
    words(c, 'a', 0, 'keep these words', true, 10)
    activity(c, 20)
    activity(c, 30, 'a')
    words(c, 'a', 1, 'discard these words', false, 40)
    expect(c.visibleMessages[0]!.text).toBe('keep these words discard these words')
    words(c, 'a', 1, '', true, 50)
    expect(c.visibleMessages.map(m => m.text)).toEqual(['keep these words'])
    expect(c.visibleMessages[0]!.waiting).toBe(false)
    expect(c.pendingSpeakers).toEqual([])
  })

  it('never displays an empty reservation through repeated pauses and timeout sweeps', () => {
    const c = setup()
    c.mergeMs = 0
    for (let n = 0; n < 20; n++) {
      activity(c, n * 100, 'a')
      expect(c.visibleMessages).toEqual([])
      expect(c.pendingSpeakers.map(p => p.id)).toEqual(['a'])
      activity(c, n * 100 + 50)
      expect(c.visibleMessages).toEqual([])
    }
    c.tick(10_000)
    expect(c.visibleMessages).toEqual([])
    expect(c.pendingSpeakers).toEqual([])
  })

  it('leavers keep readable history and stop waiting; only joiners choose colours', () => {
    const c = setup()
    activity(c, 0, 'a', 'b')
    words(c, 'a', 0, 'a', true, 1)
    words(c, 'b', 0, 'b', true, 2)
    const colors = c.messages.map(m => m.color)
    c.roster([members[1]!, { id: 'd', name: 'Bob', joinedAt: 4 }])
    activity(c, 3, 'b', 'd')
    words(c, 'd', 0, 'd', true, 4)
    expect(c.messages[0]).toMatchObject({ name: 'Alice', color: colors[0], waiting: false })
    expect(c.messages[1]!.color).toBe(colors[1])
    expect(c.messages[2]!.color).not.toBe(colors[1])
  })

  it('distinguishes twelve identical names without recolouring existing participants', () => {
    const c = new CaptionConversation()
    for (let n = 1; n <= 12; n++) {
      c.roster(Array.from({ length: n }, (_, i) => ({ id: String(i), name: 'same', joinedAt: i })))
      activity(c, n * 100, String(n - 1))
      words(c, String(n - 1), 0, 'test', true, n * 100 + 10)
    }
    expect(new Set(c.messages.map(m => m.color)).size).toBe(12)
    const colors = c.messages.map(m => m.color)
    c.roster(Array.from({ length: 11 }, (_, i) => ({ id: String(i), name: 'same', joinedAt: i })))
    expect(c.messages.map(m => m.color)).toEqual(colors)
  })

  it('bounds history and uninterrupted monologues, and clears the call', () => {
    const c = setup()
    c.keep = 20
    activity(c, 0, 'a')
    for (let u = 0; u < 1000; u++) words(c, 'a', u, 'x'.repeat(400), true, u + 1)
    expect(c.messages.length).toBeLessThanOrEqual(20)
    expect(c.messages.every(m => m.text.length <= 8400)).toBe(true)
    expect(c.messages.at(-1)!.text).toContain('x')
    c.clear()
    expect(c.messages).toEqual([])
  })
})

describe('transcript preferences', () => {
  it('is off with sidebar preferred and uncoloured messages by default', () => {
    expect(sanitizeCaptionFirst(null)).toEqual(CAPTION_FIRST_DEFAULTS)
    expect(CAPTION_FIRST_DEFAULTS).toMatchObject({ on: false, layout: 'sidebar', color: 'none', mergeSec: 10 })
    globalThis.localStorage = { getItem: () => '{}' } as unknown as Storage
    expect(loadPrefs().captionFirst).toEqual(CAPTION_FIRST_DEFAULTS)
  })
  it('persists choices and clamps invalid values', () => {
    const raw = { rev: 1, on: true, layout: 'overlay', mergeSec: -1, blur: Infinity, dim: 99, scale: NaN, history: 23.7, color: 'highlight' }
    expect(sanitizeCaptionFirst(raw)).toMatchObject({ on: true, layout: 'overlay', mergeSec: 0, blur: 8, dim: .95, scale: 1, history: 24, color: 'highlight' })
    globalThis.localStorage = { getItem: () => JSON.stringify({ captionFirst: { on: true, layout: 'sidebar', mergeSec: 7 } }) } as unknown as Storage
    expect(loadPrefs().captionFirst).toMatchObject({ on: true, layout: 'sidebar', mergeSec: 7 })
  })
  it('migrates the previously saved defaults without changing timing, size or whether the view is open', () => {
    const p = sanitizeCaptionFirst({ on: true, layout: 'overlay', tint: true, mergeSec: 3, scale: 1.2 })
    expect(p).toMatchObject({ rev: 1, on: true, layout: 'sidebar', color: 'none', mergeSec: 3, scale: 1.2 })
    expect(p).not.toHaveProperty('tint')
    expect(sanitizeCaptionFirst({ ...p, layout: 'overlay', color: 'text' })).toMatchObject({ layout: 'overlay', color: 'text' })
    expect(sanitizeCaptionFirst({ color: 'rainbow' }).color).toBe('none')
  })
})
