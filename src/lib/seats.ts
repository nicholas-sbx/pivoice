import { PRESENCE_SPRING, SEAT_SPRING, isSettled, settle, spring, stepSpring, type Spring } from './spring'

/**
 * Seating around the round table.
 *
 * Angles are in radians, measured from the bottom of the table (where you
 * always sit, angle 0) and going clockwise on screen: π/2 is the left of the
 * table, π the far side, 3π/2 the right. With N people the seats are at
 * 2πk/N. Nobody ever slides through your seat, so the angles live on the open
 * interval (0, 2π) and everyone else keeps their order around the table.
 */

export const TAU = Math.PI * 2

export interface Placed {
  id: string
  angle: number
}

/**
 * Where everyone ends up when the table changes: `placed` are the people
 * already at the table (at their current, possibly mid-animation, angles)
 * and `incoming` the people who just sat down, in the order they should fill
 * the free seats.
 *
 * Keeping everyone's order, we pick which of the N−1 seats the people who
 * are already sitting move to so the total squared distance they travel is
 * as small as possible (a small DP over people × seats), and the newcomers
 * take the seats left over. Squared, so one person doesn't do all the
 * travelling while everyone else sits still.
 */
export function planSeats(placed: readonly Placed[], incoming: readonly string[]): Map<string, number> {
  const total = placed.length + incoming.length + 1
  const slots = Array.from({ length: total - 1 }, (_, k) => (TAU * (k + 1)) / total)
  const people = [...placed].sort((a, b) => a.angle - b.angle || (a.id < b.id ? -1 : 1))
  const m = people.length
  const n = slots.length

  // best[i][j]: cheapest way to seat the first i people in the first j seats.
  const best: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(Infinity))
  for (let j = 0; j <= n; j++) best[0][j] = 0
  for (let i = 1; i <= m; i++) {
    for (let j = i; j <= n - (m - i); j++) {
      const d = people[i - 1].angle - slots[j - 1]
      const take = best[i - 1][j - 1] + d * d
      const skip = best[i][j - 1]
      best[i][j] = take <= skip ? take : skip
    }
  }

  const out = new Map<string, number>()
  const taken = new Array<boolean>(n).fill(false)
  for (let i = m, j = n; i > 0; j--) {
    const d = people[i - 1].angle - slots[j - 1]
    if (best[i][j] === best[i - 1][j - 1] + d * d) {
      out.set(people[i - 1].id, slots[j - 1])
      taken[j - 1] = true
      i--
    }
  }
  let k = 0
  for (const id of incoming) {
    while (taken[k]) k++
    out.set(id, slots[k])
    taken[k] = true
  }
  return out
}

/** Offset from the table's centre on screen (y down) for a seat at `angle` on a ring of radius `r`. */
export function seatOffset(angle: number, r: number): { x: number; y: number } {
  return { x: -r * Math.sin(angle), y: r * Math.cos(angle) }
}

/**
 * Where a seat sounds from, in Web Audio's listener space (x right, z toward
 * the back, so −z is straight ahead). You sit at the bottom facing the
 * centre of the table, so the far side is in front of you and the seat on
 * your left is ahead-left. Normalised: only the direction matters, nobody is
 * quieter for sitting further away.
 */
export function seatDirection(angle: number): { x: number; z: number } {
  const x = -Math.sin(angle)
  const z = Math.cos(angle) - 1
  const len = Math.hypot(x, z)
  return len < 1e-9 ? { x: 0, z: -1 } : { x: x / len, z: z / len }
}

/** Seat order for people joining a table you're not at yet: the ones after you (by join order) first, wrapping round. */
export function cyclicAfter(ids: readonly string[], selfId: string): string[] {
  const i = ids.indexOf(selfId)
  if (i < 0) return [...ids]
  return [...ids.slice(i + 1), ...ids.slice(0, i)]
}

/**
 * How far from the middle the seats sit for `n` people, given the biggest
 * the table can be. Half that for 1–3 people, growing evenly to full size at
 * 8, but never so small that neighbours would be closer than `minGap`
 * (centre to centre): by default enough for their name tags not to touch.
 * Nor closer to the middle than two faces' widths, so on a small screen the
 * name tag of whoever sits across from you stays clear of the room code and
 * the count in the middle of the table (on a big one, half size is further
 * out than that anyway).
 */
export function tableRadius(n: number, max: number, avatar: number, minGap = avatar * 2.3): number {
  const scale = n <= 3 ? 0.5 : Math.min(1, 0.5 + ((n - 3) / 5) * 0.5)
  const needed = n >= 2 ? minGap / (2 * Math.sin(Math.PI / n)) : 0
  return Math.min(max, Math.max(max * scale, needed, avatar * 2))
}

export interface Seat {
  id: string
  angle: Spring
  presence: Spring
  leaving: boolean
}

/**
 * The animated table: who's sitting where right now, and where they're
 * heading. `sync` takes the current list of people (in join order),
 * `step` advances the springs and reports whether anything is still moving.
 */
export class Table {
  readonly seats = new Map<string, Seat>()
  private selfId = ''

  sync(ids: readonly string[], selfId: string) {
    this.sitDown(selfId)
    const present = new Set(ids)

    const placed: Placed[] = []
    for (const seat of this.seats.values()) {
      if (seat.id === selfId) continue
      if (!present.has(seat.id)) {
        // Fades out where it is; it no longer counts when sharing out the seats.
        seat.leaving = true
        seat.presence.target = 0
        seat.angle.target = seat.angle.x
        continue
      }
      // Someone fading out who came back keeps their spot.
      seat.leaving = false
      seat.presence.target = 1
      placed.push({ id: seat.id, angle: seat.angle.x })
    }

    const incoming = cyclicAfter(ids, selfId).filter(id => id !== selfId && !this.seats.has(id))
    const plan = planSeats(placed, incoming)
    for (const [id, target] of plan) {
      const seat = this.seats.get(id)
      if (seat) seat.angle.target = target
      else this.seats.set(id, { id, angle: spring(target), presence: spring(0, 1), leaving: false })
    }
  }

  /**
   * Seats chosen by another table: the app's overlay copies the page's,
   * whose seats depend on everything that's happened in the call so far, so
   * it takes where everyone's heading rather than working it out again.
   * Newcomers fade in at their seat, people missing fade out where they are,
   * and everyone else slides to theirs, as with `sync`.
   */
  mirror(placed: readonly Placed[], selfId: string) {
    this.sitDown(selfId)
    const to = new Map(placed.map(p => [p.id, p.angle]))
    for (const seat of this.seats.values()) {
      if (seat.id === selfId) continue
      const angle = to.get(seat.id)
      if (angle === undefined) {
        seat.leaving = true
        seat.presence.target = 0
        seat.angle.target = seat.angle.x
        continue
      }
      seat.leaving = false
      seat.presence.target = 1
      seat.angle.target = angle
    }
    for (const [id, angle] of to) {
      if (id !== selfId && !this.seats.has(id)) this.seats.set(id, { id, angle: spring(angle), presence: spring(0, 1), leaving: false })
    }
  }

  /** Where everyone else is heading (people fading out aside): what `mirror` takes. */
  targets(): Placed[] {
    const out: Placed[] = []
    for (const seat of this.seats.values()) if (seat.id !== this.selfId && !seat.leaving) out.push({ id: seat.id, angle: seat.angle.target })
    return out
  }

  /** You, at the bottom, there for good. */
  private sitDown(selfId: string) {
    this.selfId = selfId
    const me = this.seats.get(selfId)
    if (!me) this.seats.set(selfId, { id: selfId, angle: spring(0), presence: spring(0, 1), leaving: false })
    else {
      me.leaving = false
      me.presence.target = 1
    }
  }

  /** Advances every spring by `dt` seconds. Returns true while anything is still moving. */
  step(dt: number): boolean {
    let moving = false
    for (const seat of this.seats.values()) {
      if (seat.id === this.selfId) {
        seat.angle.x = seat.angle.target = seat.angle.v = 0
      } else {
        stepSpring(seat.angle, dt, SEAT_SPRING)
        if (isSettled(seat.angle)) settle(seat.angle)
        else moving = true
      }
      stepSpring(seat.presence, dt, PRESENCE_SPRING)
      if (isSettled(seat.presence, 1e-3)) settle(seat.presence)
      else moving = true
      if (seat.leaving && seat.presence.x <= 0.001 && seat.presence.target === 0) {
        this.seats.delete(seat.id)
      }
    }
    return moving
  }

  /** Jump straight to the end of every animation (reduced motion). */
  finish() {
    for (const seat of this.seats.values()) {
      settle(seat.angle)
      settle(seat.presence)
      if (seat.leaving) this.seats.delete(seat.id)
    }
  }
}
