import { computed, nextTick, onBeforeUnmount, onMounted, reactive, watch, type Ref } from 'vue'
import type { Member } from '../net/protocol'
import { seatOffset } from './seats'
import type { Seating } from './seating'
import { SEAT_SPRING, isSettled, settle, spring, stepSpring } from './spring'
import { snapNow } from './snap'

/**
 * What the table on screen shares, whichever size and window it's drawn at
 * (the page's, the pop-out's): measuring the space, the ring the seats sit
 * on, the radius spring, and painting each seat where the shared seating
 * says it is. The seats and their angles belong to `Seating`; a view only
 * draws them, and gives it its window to get animation frames from.
 */

export interface Geometry {
  avatar: number
  /** The most the seats can be from the middle. */
  ring: number
  cx: number
  cy: number
}

export interface TableViewOptions {
  seating: Seating
  root: Ref<HTMLElement | undefined>
  tableEl: Ref<HTMLElement | undefined>
  members: () => Member[]
  selfId: () => string
  geometry: (w: number, h: number) => Geometry
  /** How far out the seats sit, for this many people at the table. */
  radius: (g: Geometry, present: number) => number
}

/**
 * The part of a box that's on screen, in the box's own coordinates: where
 * that part starts inside the box, and how big it is.
 *
 * A page can be laid out in something bigger than the window it's shown in,
 * and not always by its own doing: an embed whose container is sized from
 * the display, a column that can't shrink below its content, a window made
 * smaller before the page caught up. Drawn across the whole of that box, the
 * table's middle — where you sit, and where everyone else is put — lands off
 * the window's bottom right corner. Measured against what's on screen, it
 * stays in the middle of what you can see, whichever of those it was.
 */
export function visibleBox(
  box: { left: number; top: number; width: number; height: number },
  width: number,
  height: number
): { x: number; y: number; w: number; h: number } {
  // The window's edges, in the box's own coordinates.
  const x = Math.max(0, -box.left)
  const y = Math.max(0, -box.top)
  const right = Math.min(box.width, width - box.left)
  const bottom = Math.min(box.height, height - box.top)
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) }
}

export function useTableView(opts: TableViewOptions) {
  const { seating, root, tableEl } = opts
  /** The space the table's drawn in: the part of it on screen (see visibleBox). */
  const size = reactive({ w: 0, h: 0 })
  /** Where that part starts in it. Nothing to add to unless some of it is off screen. */
  const shown = reactive({ x: 0, y: 0 })
  const geometry = computed(() => opts.geometry(size.w, size.h))
  const seatEls = new Map<string, HTMLElement>()
  /** The last we knew of everyone, so someone fading out still has a name. */
  const known = new Map<string, Member>()
  /**
   * How far out the seats are right now. The table grows with the number of
   * people, on a spring like everything else so the seats ease outward as
   * people sit down. Per view, since it depends on this view's size.
   */
  const radius = spring(0)
  /** The window this is drawn in: with a pop-out, not the page's own. */
  let win: Window & typeof globalThis = window

  const byId = computed(() => {
    const map = new Map<string, Member>()
    for (const m of opts.members()) {
      map.set(m.id, m)
      known.set(m.id, m)
    }
    return map
  })

  function member(id: string): Member | undefined {
    return byId.value.get(id) ?? known.get(id)
  }

  function retarget(snap: boolean) {
    radius.target = opts.radius(geometry.value, seating.presentCount())
    if (snap || radius.x === 0) settle(radius)
  }

  /** To the nearest whole device pixel (a CSS pixel is 1.25 of them at Windows' 125% scaling). */
  function px(v: number): number {
    const dpr = win.devicePixelRatio || 1
    return Math.round(v * dpr) / dpr
  }

  function paintSeat(id: string) {
    const seat = seating.table.seats.get(id)
    const el = seatEls.get(id)
    if (!seat || !el) return
    const g = geometry.value
    const { x, y } = seatOffset(seat.angle.x, radius.x)
    const p = Math.max(0, Math.min(1, seat.presence.x))
    const left = shown.x + g.cx + x - g.avatar / 2
    const top = shown.y + g.cy + y - g.avatar / 2
    // At rest: whole pixels and no scale, so the face and name are drawn
    // crisp rather than resampled. Only while moving is it fractional.
    const still = seat.angle.v === 0 && seat.presence.v === 0 && p === 1 && radius.v === 0
    el.style.transform = still
      ? `translate(${px(left)}px, ${px(top)}px)`
      : `translate(${left.toFixed(2)}px, ${top.toFixed(2)}px) scale(${(0.55 + 0.45 * p).toFixed(4)})`
    // Come to rest: its name tag onto whole pixels too (it's centred under the face, on a fractional width).
    const tag = still && !el.dataset.still ? el.querySelector<HTMLElement>('.tag') : null
    el.dataset.still = still ? '1' : ''
    if (tag) snapNow(tag)
    el.style.opacity = p === 1 ? '' : p.toFixed(3)
  }

  function paintTable() {
    const el = tableEl.value
    if (!el) return
    const g = geometry.value
    const still = radius.v === 0
    const r = Math.max(0, radius.x - g.avatar * 0.22)
    const d = still ? 2 * Math.round(r) : 2 * r
    const left = shown.x + g.cx - d / 2
    const top = shown.y + g.cy - d / 2
    el.style.width = el.style.height = d.toFixed(2) + 'px'
    el.style.transform = still ? `translate(${px(left)}px, ${px(top)}px)` : `translate(${left.toFixed(2)}px, ${top.toFixed(2)}px)`
  }

  function paint() {
    paintTable()
    for (const id of seating.table.seats.keys()) paintSeat(id)
  }

  function setSeatEl(id: string) {
    return (el: unknown) => {
      if (el instanceof HTMLElement) {
        seatEls.set(id, el)
        paintSeat(id)
      } else seatEls.delete(id)
    }
  }

  // Seats come and go: the table's size follows, and so does who we still know a name for.
  watch(
    seating.seatIds,
    ids => {
      for (const id of known.keys()) if (!ids.includes(id)) known.delete(id)
      retarget(false)
      void nextTick(paint)
      seating.kick()
    },
    { immediate: true }
  )

  // A resized window — or one showing a different part of the space — jumps
  // straight to the new size; only people joining and leaving animate.
  watch([geometry, () => shown.x, () => shown.y], () => {
    retarget(true)
    paint()
  })

  let observer: ResizeObserver | null = null
  let detach: (() => void) | null = null
  let deaf: (() => void) | null = null
  onMounted(() => {
    const el = root.value!
    win = el.ownerDocument.defaultView ?? window
    const measure = () => {
      const doc = el.ownerDocument
      // The window's own clientWidth/Height: innerWidth/Height count its scrollbars.
      const v = visibleBox(
        el.getBoundingClientRect(),
        doc.documentElement.clientWidth || win.innerWidth,
        doc.documentElement.clientHeight || win.innerHeight
      )
      shown.x = v.x
      shown.y = v.y
      size.w = v.w
      size.h = v.h
    }
    measure()
    observer = new win.ResizeObserver(measure)
    observer.observe(el)
    // The window can shrink without the space being told: a page laid out
    // wider or taller than its window never sees its own box change.
    const viewport = win.visualViewport
    win.addEventListener('resize', measure)
    viewport?.addEventListener('resize', measure)
    deaf = () => {
      win.removeEventListener('resize', measure)
      viewport?.removeEventListener('resize', measure)
    }
    detach = seating.attach({
      win,
      frame(dt) {
        let moving = false
        stepSpring(radius, dt, SEAT_SPRING)
        if (isSettled(radius, 0.05)) settle(radius)
        else moving = true
        paint()
        return moving
      },
      finish() {
        retarget(true)
        paint()
      }
    })
    void nextTick(paint)
  })

  onBeforeUnmount(() => {
    observer?.disconnect()
    deaf?.()
    detach?.()
  })

  return { size, geometry, member, retarget, setSeatEl, seatIds: seating.seatIds }
}

/** What's shown for each person at the table, from the call's state. */
export interface SeatStateProps {
  selfId: string
  speaking: Set<string>
  /** Making any sound at all: a thin ring, under the full one for speaking. */
  audible: Set<string>
  /** Your own state, straight from the controls rather than waiting on the roster round trip. */
  selfMuted: boolean
  selfDeafened: boolean
  silenced: Record<string, boolean>
}

export function useSeatStates(props: SeatStateProps, member: (id: string) => Member | undefined) {
  const isSelf = (id: string) => id === props.selfId
  const mutedOf = (id: string) => (isSelf(id) ? props.selfMuted || props.selfDeafened : !!member(id)?.muted)
  const deafenedOf = (id: string) => (isSelf(id) ? props.selfDeafened : !!member(id)?.deafened)
  const speakingOf = (id: string) => props.speaking.has(id) && !mutedOf(id) && !props.silenced[id]
  const audibleOf = (id: string) => props.audible.has(id) && !mutedOf(id) && !props.silenced[id]
  function moodOf(id: string): 'idle' | 'talking' | 'deafened' | 'away' {
    if (member(id)?.away) return 'away'
    if (deafenedOf(id)) return 'deafened'
    return speakingOf(id) ? 'talking' : 'idle'
  }
  return { isSelf, mutedOf, deafenedOf, speakingOf, audibleOf, moodOf }
}
