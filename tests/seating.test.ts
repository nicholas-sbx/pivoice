import { describe, expect, it } from 'vitest'
import { Seating, type FrameWindow, type SeatView } from '../src/lib/seating'
import { TAU, Table } from '../src/lib/seats'

/** A window with a requestAnimationFrame you turn by hand, that can be hidden. */
function fakeWindow(visible = true) {
  let next = 0
  const queue = new Map<number, () => void>()
  const listeners = new Set<() => void>()
  const doc = {
    visibilityState: (visible ? 'visible' : 'hidden') as DocumentVisibilityState,
    addEventListener: (_type: string, fn: () => void) => void listeners.add(fn),
    removeEventListener: (_type: string, fn: () => void) => void listeners.delete(fn)
  }
  const win = {
    requestAnimationFrame: (cb: () => void) => {
      queue.set(++next, cb)
      return next
    },
    cancelAnimationFrame: (h: number) => void queue.delete(h),
    document: doc
  }
  return {
    win: win as unknown as FrameWindow,
    /** Frames asked for and not yet drawn. */
    pending: () => queue.size,
    /** Draw one frame (does nothing while hidden, like a browser). */
    draw() {
      if (doc.visibilityState !== 'visible') return
      const cbs = [...queue.values()]
      queue.clear()
      for (const cb of cbs) cb()
    },
    setVisible(v: boolean) {
      doc.visibilityState = v ? 'visible' : 'hidden'
      for (const fn of [...listeners]) fn()
    }
  }
}

function setup(opts: { reducedMotion?: boolean } = {}) {
  let t = 0
  const timers = new Map<number, () => void>()
  let timerId = 0
  const heard = new Map<string, number>()
  const log: [string, number][] = []
  const seating = new Seating(
    (id, angle) => {
      heard.set(id, angle)
      log.push([id, angle])
    },
    {
      now: () => t,
      reducedMotion: () => !!opts.reducedMotion,
      setTimer: fn => {
        timers.set(++timerId, fn)
        return timerId
      },
      clearTimer: h => void timers.delete(h as number)
    }
  )
  return {
    seating,
    heard,
    log,
    timers,
    /** 16 ms pass, then the window draws. */
    frame(w: ReturnType<typeof fakeWindow>) {
      t += 16
      w.draw()
    },
    /** Draws until nothing more is asked for. */
    play(w: ReturnType<typeof fakeWindow>, max = 2000) {
      let n = 0
      while (w.pending() && n++ < max) this.frame(w)
      return n
    }
  }
}

/** A view that has nothing of its own to animate. */
function plainView(win: FrameWindow): SeatView & { frames: number; finished: number } {
  const v = {
    win,
    frames: 0,
    finished: 0,
    frame() {
      v.frames++
      return false
    },
    finish() {
      v.finished++
    }
  }
  return v
}

const slot = (k: number, n: number) => (TAU * k) / n
const close = (a: number | undefined, b: number) => expect(a).toBeCloseTo(b, 9)

/** Where everyone ends up after each change has been played out in full, with the same table the page always used. */
function played(...steps: string[][]): Map<string, number> {
  const table = new Table()
  for (const ids of steps) {
    table.sync(ids, 'me')
    for (let i = 0; i < 600; i++) table.step(1 / 60)
  }
  return new Map([...table.seats].map(([id, seat]) => [id, seat.angle.x]))
}
/** Where a ends up when b sits down next to them. */
const A_WITH_B = played(['me', 'a'], ['me', 'a', 'b']).get('a')!
const abc = played(['me', 'a'], ['me', 'a', 'b'], ['me', 'a', 'b', 'c'])
const sorted = (m: Map<string, number>) => [...m.values()].sort((a, b) => a - b)

describe('Seating, with nothing on screen', () => {
  it('sends the angles at once, so a voice is placed before anyone looks', () => {
    const s = setup()
    s.seating.sync(['me', 'a', 'b'], 'me')
    close(s.heard.get('a'), slot(1, 3))
    close(s.heard.get('b'), slot(2, 3))
    expect(s.heard.has('me')).toBe(false)
  })

  it('moves everyone to their final seats when someone joins, without a frame', () => {
    const s = setup()
    s.seating.sync(['me', 'a', 'b'], 'me')
    s.seating.sync(['me', 'a', 'b', 'c'], 'me')
    const want = played(['me', 'a', 'b'], ['me', 'a', 'b', 'c'])
    for (const id of ['a', 'b', 'c']) close(s.heard.get(id), want.get(id)!)
    expect(sorted(s.heard)).toEqual([slot(1, 4), slot(2, 4), slot(3, 4)].map(v => expect.closeTo(v, 9)))
  })

  it('closes the gap when someone leaves, and forgets their seat', () => {
    const s = setup()
    s.seating.sync(['me', 'a', 'b', 'c'], 'me')
    s.seating.sync(['me', 'a', 'c'], 'me')
    const want = played(['me', 'a', 'b', 'c'], ['me', 'a', 'c'])
    close(s.heard.get('a'), want.get('a')!)
    close(s.heard.get('c'), want.get('c')!)
    expect([s.heard.get('a')!, s.heard.get('c')!].sort((x, y) => x - y)).toEqual([slot(1, 3), slot(2, 3)].map(v => expect.closeTo(v, 9)))
    expect(s.seating.seatIds.value).toEqual(['a', 'c', 'me'])
    expect(s.seating.angleOf('b')).toBeUndefined()
  })

  it('arrives where the animation would have', () => {
    // Same joins and leaves, once as a person watching sees it and once with nobody watching.
    const steps = [['me', 'a'], ['me', 'a', 'b'], ['me', 'a', 'b', 'c'], ['me', 'a', 'c'], ['me', 'c'], ['me', 'c', 'd', 'e']]

    const reference = new Table()
    for (const ids of steps) {
      reference.sync(ids, 'me')
      for (let i = 0; i < 600; i++) reference.step(1 / 60)
    }

    const s = setup()
    for (const ids of steps) s.seating.sync(ids, 'me')
    for (const id of ['c', 'd', 'e']) close(s.heard.get(id), reference.seats.get(id)!.angle.x)
    expect([...s.seating.table.seats.keys()].sort()).toEqual([...reference.seats.keys()].sort())
  })

  it('tells a new sink where everyone is on flush, and only then', () => {
    const s = setup()
    s.seating.sync(['me', 'a', 'b'], 'me')
    const before = s.log.length
    s.seating.flush()
    expect(s.log.length).toBe(before + 2)
    s.seating.sync(['me', 'a', 'b'], 'me')
    expect(s.log.length).toBe(before + 2)
  })

  it('starts from an empty table after a reset', () => {
    const s = setup()
    s.seating.sync(['me', 'a'], 'me')
    s.seating.reset()
    expect(s.seating.seatIds.value).toEqual([])
    s.seating.sync(['me2', 'b'], 'me2')
    expect(s.seating.seatIds.value).toEqual(['b', 'me2'])
    close(s.heard.get('b'), Math.PI)
  })
})

describe('Seating, with a view', () => {
  it('jumps to the end when its window is hidden (no frame would ever come)', () => {
    const s = setup()
    const w = fakeWindow(false)
    const view = plainView(w.win)
    s.seating.attach(view)
    s.seating.sync(['me', 'a'], 'me')
    s.seating.sync(['me', 'a', 'b'], 'me')
    expect(w.pending()).toBe(0)
    const want = played(['me', 'a'], ['me', 'a', 'b'])
    close(s.heard.get('a'), want.get('a')!)
    close(s.heard.get('b'), want.get('b')!)
    expect(view.frames).toBe(0)
    expect(view.finished).toBeGreaterThan(0)
  })

  it('animates from the window\'s frames while it is visible, to the same end', () => {
    const s = setup()
    const w = fakeWindow(true)
    const view = plainView(w.win)
    s.seating.attach(view)
    s.seating.sync(['me', 'a'], 'me')
    s.play(w)
    s.seating.sync(['me', 'a', 'b'], 'me')
    // Sliding: a is on its way, not there yet.
    const want = played(['me', 'a'], ['me', 'a', 'b'])
    expect(w.pending()).toBe(1)
    s.frame(w)
    const mid = s.heard.get('a')!
    expect(Math.abs(mid - want.get('a')!)).toBeGreaterThan(0.01)
    expect(Math.abs(mid - Math.PI)).toBeGreaterThan(0)
    s.play(w)
    close(s.heard.get('a'), want.get('a')!)
    close(s.heard.get('b'), want.get('b')!)
    expect(view.frames).toBeGreaterThan(10)
    expect(w.pending()).toBe(0)
  })

  it('takes its frames from the visible window when the other is hidden', () => {
    const s = setup()
    const page = fakeWindow(false)
    const pip = fakeWindow(true)
    s.seating.attach(plainView(page.win))
    const pipView = plainView(pip.win)
    s.seating.attach(pipView)
    s.seating.sync(['me', 'a'], 'me')
    s.seating.sync(['me', 'a', 'b'], 'me')
    expect(page.pending()).toBe(0)
    expect(pip.pending()).toBe(1)
    s.play(pip)
    close(s.heard.get('a'), A_WITH_B)
    expect(pipView.frames).toBeGreaterThan(0)
  })

  it('finishes straight away if the window is hidden mid-move, and picks up in another', () => {
    const s = setup()
    const page = fakeWindow(true)
    s.seating.attach(plainView(page.win))
    s.seating.sync(['me', 'a'], 'me')
    s.play(page)
    s.seating.sync(['me', 'a', 'b'], 'me')
    s.frame(page)
    page.setVisible(false)
    expect(page.pending()).toBe(0)
    close(s.heard.get('a'), A_WITH_B)

    // Moving again with a second, visible window: it gets the frames.
    const pip = fakeWindow(true)
    const detach = s.seating.attach(plainView(pip.win))
    s.seating.sync(['me', 'a', 'b', 'c'], 'me')
    expect(page.pending()).toBe(0)
    expect(pip.pending()).toBe(1)
    // The window being drawn in goes away: what is moving is finished.
    detach()
    close(s.heard.get('a'), abc.get('a')!)
    close(s.heard.get('c'), abc.get('c')!)
  })

  it('moves to the other window when the one drawing is hidden', () => {
    const s = setup()
    const page = fakeWindow(true)
    const pip = fakeWindow(true)
    s.seating.attach(plainView(page.win))
    s.seating.attach(plainView(pip.win))
    s.seating.sync(['me', 'a'], 'me')
    s.seating.sync(['me', 'a', 'b'], 'me')
    expect(page.pending()).toBe(1)
    page.setVisible(false)
    expect(page.pending()).toBe(0)
    expect(pip.pending()).toBe(1)
    s.play(pip)
    close(s.heard.get('a'), A_WITH_B)
  })

  it('gives up on a window that says it is visible but never draws', () => {
    const s = setup()
    const w = fakeWindow(true)
    const view = plainView(w.win)
    s.seating.attach(view)
    s.seating.sync(['me', 'a'], 'me')
    s.seating.sync(['me', 'a', 'b'], 'me')
    expect(w.pending()).toBe(1)
    expect(s.timers.size).toBe(1)
    ;[...s.timers.values()][0]()
    expect(w.pending()).toBe(0)
    close(s.heard.get('a'), A_WITH_B)
    expect(view.finished).toBeGreaterThan(0)
  })

  it('lets the view hold the animation on while its own springs move', () => {
    const s = setup()
    const w = fakeWindow(true)
    let left = 5
    s.seating.attach({
      win: w.win,
      frame: () => --left > 0,
      finish: () => {}
    })
    s.seating.kick()
    expect(s.play(w)).toBe(5)
  })

  it('jumps rather than slides with reduced motion', () => {
    const s = setup({ reducedMotion: true })
    const w = fakeWindow(true)
    s.seating.attach(plainView(w.win))
    s.seating.sync(['me', 'a'], 'me')
    s.seating.sync(['me', 'a', 'b'], 'me')
    s.frame(w)
    close(s.heard.get('a'), A_WITH_B)
    expect(w.pending()).toBe(0)
  })

  it('stops asking for frames when the last view goes', () => {
    const s = setup()
    const w = fakeWindow(true)
    const detach = s.seating.attach(plainView(w.win))
    s.seating.sync(['me', 'a'], 'me')
    s.seating.sync(['me', 'a', 'b'], 'me')
    detach()
    expect(w.pending()).toBe(0)
    close(s.heard.get('a'), A_WITH_B)
  })
})
