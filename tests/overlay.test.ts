import { describe, expect, it } from 'vitest'
import { nextTick, reactive } from 'vue'
import { Seating } from '../src/lib/seating'
import { DEFAULT_PREFS } from '../src/lib/prefs'
import { native, type NativeBridge } from '../src/native/bridge'
import { driveOverlay, overlayPlacing, type OverlayCall } from '../src/native/overlay'
import type { FromApp, ToApp } from '../src/native/protocol'
import type { Member } from '../src/net/protocol'

const member = (id: string): Member => ({ id, name: id.toUpperCase(), joinedAt: 0, muted: false, deafened: false, ll: false, away: false })

/** Stands in for the app: remembers what it's sent, says yes to showing the overlay. */
function fakeApp() {
  const sent: ToApp[] = []
  const listeners = new Set<(m: FromApp) => void>()
  const bridge = {
    send: (m: ToApp) => void sent.push(JSON.parse(JSON.stringify(m)) as ToApp),
    on: (l: (m: FromApp) => void) => (listeners.add(l), () => listeners.delete(l)),
    request: async (m: ToApp) => {
      bridge.send(m)
      return m.t === 'overlay' && m.op === 'show' ? { t: 'overlay', on: true } : null
    }
  }
  return { bridge: bridge as unknown as NativeBridge, sent }
}

const settle = async () => {
  for (let i = 0; i < 3; i++) await nextTick()
}

describe('the overlay, from the page', () => {
  it('sends nothing at all while it is off, then shows it with the call and follows it', async () => {
    native.state = 'ready'
    native.app = { version: '1', protocol: 1, os: 'linux', arch: 'amd64', overlay: true }
    const call = reactive<OverlayCall>({
      phase: 'room',
      selfId: 'me',
      members: [member('me'), member('a')],
      muted: false,
      deafened: false,
      micProblem: null,
      silenced: {},
      prefs: { ...DEFAULT_PREFS, overlay: { ...DEFAULT_PREFS.overlay } }
    })
    const seating = new Seating(() => {})
    seating.sync(['me', 'a'], 'me')
    const { bridge, sent } = fakeApp()
    driveOverlay(bridge, call, seating)
    await settle()
    call.members.push(member('b'))
    seating.sync(['me', 'a', 'b'], 'me')
    await settle()
    expect(sent).toEqual([])

    call.prefs.overlay = { ...call.prefs.overlay, on: true, anchor: 'bottom-left' }
    await settle()
    // Each once (the app keeps the latest of each, so the order doesn't matter).
    const ops = sent.map(m => (m.t === 'overlay' ? m.op : m.t))
    expect([...ops].sort()).toEqual(['look', 'show', 'state'])
    const show = sent.find(m => m.t === 'overlay' && m.op === 'show') as Extract<ToApp, { op: 'show' }>
    expect(show.place).toEqual({ monitor: '', anchor: 'bottom-left', margin: 24, size: 260 })
    const state = (sent.find(m => m.t === 'overlay' && m.op === 'state') as Extract<ToApp, { op: 'state' }>).state
    expect(state.members.map(m => m.id)).toEqual(['me', 'a', 'b'])
    expect(state.seats).toEqual(seating.targets())

    // Someone leaves: the new seats go across. Muting: so does that.
    sent.length = 0
    call.members.splice(1, 1)
    seating.sync(['me', 'b'], 'me')
    await settle()
    call.muted = true
    await settle()
    const states = sent.filter((m): m is Extract<ToApp, { op: 'state' }> => m.t === 'overlay' && m.op === 'state')
    expect(states.at(-1)!.state.seats.map(s => s.id)).toEqual(['b'])
    expect(states.at(-1)!.state.selfMuted).toBe(true)

    // Its settings open: an outline. Moved: shown again, somewhere else.
    sent.length = 0
    overlayPlacing.value = true
    call.prefs.overlay = { ...call.prefs.overlay, margin: 40 }
    await settle()
    expect(sent.some(m => m.t === 'overlay' && m.op === 'look' && m.look.placing)).toBe(true)
    expect(sent.some(m => m.t === 'overlay' && m.op === 'show' && m.place.margin === 40)).toBe(true)
    overlayPlacing.value = false

    // Leaving the call takes it down.
    sent.length = 0
    call.phase = 'home'
    await settle()
    expect(sent).toEqual([{ t: 'overlay', op: 'hide' }])
  })
})
