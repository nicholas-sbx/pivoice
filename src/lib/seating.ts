import { shallowRef, type ShallowRef } from 'vue'
import { Table } from './seats'

/**
 * Who sits where, once per call. The audio and every view of the table (the
 * one in the page, the one in a Picture-in-Picture window) read the same
 * seats, so a voice always comes from where its face is drawn.
 *
 * The audio can't wait for a view: browsers pause requestAnimationFrame in a
 * hidden tab or a minimised window, and a seat that only moved while a view
 * painted would leave someone who joins meanwhile sounding from the wrong
 * place until the window is looked at again. So the model owns the springs
 * and sends the angles itself. Views only draw, and lend it their window
 * to get frames from.
 *
 * Frames come from a window that is visible right now (the page's, or a
 * Picture-in-Picture window's: each has its own requestAnimationFrame, and
 * the opener's is paused while it's hidden). If none is, nobody could see the
 * animation, so it isn't played: every seat jumps to where it's going and the
 * final angles go out at once. The same when a frame doesn't come for a
 * second, in case a window says it's visible but isn't being drawn.
 */

/** The parts of a window the model uses, so a test can stand in for one. */
export interface FrameWindow {
  requestAnimationFrame(cb: (time: number) => void): number
  cancelAnimationFrame(handle: number): void
  document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
}

/** Something that draws the table in a window. */
export interface SeatView {
  /** The window it's drawn in, and so whose frames to use. */
  win: FrameWindow
  /** A frame of `dt` seconds: step whatever the view animates itself and paint. True while still moving. */
  frame(dt: number): boolean
  /** Nobody's watching the animation: jump to its end and paint. */
  finish(): void
}

export interface SeatingOptions {
  /** Prefers reduced motion: seats jump straight to where they're going. */
  reducedMotion?: () => boolean
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** How long a frame may take to come before the window is taken not to be drawing at all. */
const STALL_MS = 1000

export class Seating {
  table = new Table()
  /** Seats to draw, people fading out included. You last, so you're drawn on top of anyone sliding past the bottom. */
  readonly seatIds: ShallowRef<string[]> = shallowRef([])

  private selfId = ''
  private views = new Set<SeatView>()
  /** What the sink last heard, so it's only told about changes. */
  private sent = new Map<string, number>()
  private raf: { win: FrameWindow; handle: number } | null = null
  private stall: unknown = null
  /** Inside a frame: whatever a view does there, the frame itself asks for the next. */
  private ticking = false
  private last = 0
  private readonly reduced: () => boolean
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  /** `sink` is told where each other person sits, whenever it changes (it's the spatial audio). */
  constructor(
    private sink: (id: string, angle: number) => void,
    opts: SeatingOptions = {}
  ) {
    this.reduced = opts.reducedMotion ?? (() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
    this.now = opts.now ?? (() => performance.now())
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /** The people at the table now, in join order. Seats slide to their new places. */
  sync(ids: readonly string[], selfId: string) {
    this.selfId = selfId
    this.table.sync(ids, selfId)
    this.refresh()
    // Newcomers sit at their final angle from the start, and the audio shouldn't wait a frame for it.
    this.push()
    this.kick()
  }

  /** Everyone's gone (the call ended): the next one starts with an empty table. */
  reset() {
    this.cancel()
    this.table = new Table()
    this.selfId = ''
    this.sent.clear()
    this.refresh()
  }

  /** The sink changed (a new audio engine): tell it where everyone is again. */
  flush() {
    this.sent.clear()
    this.push()
  }

  /** Seats not leaving, for sizing the table. */
  presentCount(): number {
    let n = 0
    for (const seat of this.table.seats.values()) if (!seat.leaving) n++
    return n
  }

  /** The angle of someone's seat, if they have one. */
  angleOf(id: string): number | undefined {
    return this.table.seats.get(id)?.angle.x
  }

  /** A view starts drawing the table. Returns the way to stop. */
  attach(view: SeatView): () => void {
    this.views.add(view)
    const onVisible = () => this.reschedule()
    view.win.document.addEventListener('visibilitychange', onVisible)
    // It may be the only window anyone can see: continue (or end) what's moving.
    this.reschedule()
    return () => {
      this.views.delete(view)
      view.win.document.removeEventListener('visibilitychange', onVisible)
      this.reschedule()
    }
  }

  /** Something a view animates (or the seats) just changed: make sure frames are coming. */
  kick() {
    if (this.raf || this.ticking) return
    this.last = this.now()
    this.schedule()
  }

  private visible(win: FrameWindow): boolean {
    try {
      return win.document.visibilityState === 'visible'
    } catch {
      // A window that was closed under us.
      return false
    }
  }

  private cancel() {
    if (this.raf) {
      try {
        this.raf.win.cancelAnimationFrame(this.raf.handle)
      } catch {
        // Closed.
      }
      this.raf = null
    }
    if (this.stall !== null) this.clearTimer(this.stall)
    this.stall = null
  }

  /** Something about the windows changed: if frames were due, ask the right window for them. */
  private reschedule() {
    if (!this.raf) return
    this.cancel()
    this.schedule()
  }

  private schedule() {
    let win: FrameWindow | null = null
    for (const v of this.views) {
      if (this.visible(v.win)) {
        win = v.win
        break
      }
    }
    if (!win) return this.finish()
    this.raf = { win, handle: win.requestAnimationFrame(this.tick) }
    this.stall = this.setTimer(() => this.finish(), STALL_MS)
  }

  private tick = () => {
    this.raf = null
    if (this.stall !== null) this.clearTimer(this.stall)
    this.stall = null
    // Our own clock, not the frame's: a Picture-in-Picture window's time starts when it opened.
    const t = this.now()
    const dt = Math.min(0.05, (t - this.last) / 1000)
    this.last = t
    if (this.reduced()) return this.finish()
    let moving = this.table.step(dt)
    this.refresh()
    this.ticking = true
    try {
      for (const v of this.views) if (v.frame(dt)) moving = true
    } finally {
      this.ticking = false
    }
    this.push()
    if (moving) this.schedule()
  }

  /** Nothing to watch: everything jumps to where it's going. */
  private finish() {
    this.cancel()
    this.table.finish()
    this.refresh()
    for (const v of this.views) v.finish()
    this.push()
  }

  private refresh() {
    const ids = [...this.table.seats.keys()].filter(id => id !== this.selfId)
    if (this.table.seats.has(this.selfId)) ids.push(this.selfId)
    const cur = this.seatIds.value
    if (ids.length !== cur.length || ids.some((id, i) => id !== cur[i])) this.seatIds.value = ids
    for (const id of this.sent.keys()) if (!this.table.seats.has(id)) this.sent.delete(id)
  }

  private push() {
    for (const seat of this.table.seats.values()) {
      if (seat.id === this.selfId) continue
      const a = seat.angle.x
      if (this.sent.get(seat.id) === a) continue
      this.sent.set(seat.id, a)
      this.sink(seat.id, a)
    }
  }
}
