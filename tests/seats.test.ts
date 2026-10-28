import { describe, expect, it } from 'vitest'
import { Table, TAU, cyclicAfter, planSeats, seatDirection, seatOffset, tableRadius } from '../src/lib/seats'

const slot = (k: number, n: number) => (TAU * k) / n
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 9)

/** Every order-preserving way to put `angles` into the N−1 seats, for checking the DP. */
function bruteForce(angles: number[], incoming: number): number {
  const n = angles.length + incoming
  const slots = Array.from({ length: n }, (_, k) => slot(k + 1, n + 1))
  const sorted = [...angles].sort((a, b) => a - b)
  let best = Infinity
  const pick = (i: number, from: number, cost: number) => {
    if (i === sorted.length) return void (best = Math.min(best, cost))
    for (let j = from; j <= slots.length - (sorted.length - i); j++) pick(i + 1, j + 1, cost + (sorted[i] - slots[j]) ** 2)
  }
  pick(0, 0, 0)
  return best
}

function cost(placed: { id: string; angle: number }[], plan: Map<string, number>) {
  return placed.reduce((s, p) => s + (p.angle - plan.get(p.id)!) ** 2, 0)
}

describe('planSeats', () => {
  it('puts the first person opposite you', () => {
    const plan = planSeats([], ['a'])
    close(plan.get('a')!, Math.PI)
  })

  it('spreads newcomers evenly when nobody is seated yet', () => {
    const plan = planSeats([], ['a', 'b', 'c'])
    expect([...plan.values()].sort()).toEqual([slot(1, 4), slot(2, 4), slot(3, 4)])
    // In the order given, round the table clockwise from your left.
    expect(plan.get('a')).toBe(slot(1, 4))
    expect(plan.get('c')).toBe(slot(3, 4))
  })

  it('moves the person across the table only a third of the way when a second joins', () => {
    const plan = planSeats([{ id: 'a', angle: Math.PI }], ['b'])
    const a = plan.get('a')!
    expect([slot(1, 3), slot(2, 3)]).toContainEqual(a)
    expect(plan.get('b')).not.toBe(a)
  })

  it('closes the gap someone left with the least movement', () => {
    // Four of us: a, b, c at quarter turns. b leaves.
    const plan = planSeats(
      [
        { id: 'a', angle: slot(1, 4) },
        { id: 'c', angle: slot(3, 4) }
      ],
      []
    )
    close(plan.get('a')!, slot(1, 3))
    close(plan.get('c')!, slot(2, 3))
  })

  it('keeps everyone in the same order', () => {
    const placed = [0.3, 1.1, 2.0, 2.2, 4.0, 5.9].map((angle, i) => ({ id: String(i), angle }))
    const plan = planSeats(placed, ['x', 'y'])
    const targets = placed.map(p => plan.get(p.id)!)
    for (let i = 1; i < targets.length; i++) expect(targets[i]).toBeGreaterThan(targets[i - 1])
  })

  it('finds the cheapest order-preserving assignment', () => {
    let seed = 7
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let trial = 0; trial < 300; trial++) {
      const m = 1 + Math.floor(rand() * 7)
      const incoming = Math.floor(rand() * 4)
      const placed = Array.from({ length: m }, (_, i) => ({ id: 'p' + i, angle: 0.01 + rand() * (TAU - 0.02) }))
      const ids = Array.from({ length: incoming }, (_, i) => 'n' + i)
      const plan = planSeats(placed, ids)
      expect(cost(placed, plan)).toBeCloseTo(bruteForce(placed.map(p => p.angle), incoming), 9)
      // Everyone gets a different seat, and every seat is used.
      const used = [...plan.values()].sort((a, b) => a - b)
      const n = m + incoming + 1
      expect(used.length).toBe(n - 1)
      used.forEach((a, k) => close(a, slot(k + 1, n)))
    }
  })
})

describe('geometry', () => {
  it('puts angle 0 at the bottom, π/2 on the left', () => {
    const bottom = seatOffset(0, 100)
    close(bottom.x, 0)
    close(bottom.y, 100)
    const left = seatOffset(Math.PI / 2, 100)
    close(left.x, -100)
    close(left.y, 0)
  })

  it('hears the far side in front and the left seat on the left', () => {
    const far = seatDirection(Math.PI)
    close(far.x, 0)
    close(far.z, -1)
    const left = seatDirection(Math.PI / 2)
    expect(left.x).toBeLessThan(0)
    expect(left.z).toBeLessThan(0)
    const right = seatDirection((3 * Math.PI) / 2)
    expect(right.x).toBeGreaterThan(0)
    // Unit length: direction only.
    close(Math.hypot(left.x, left.z), 1)
  })

  it('orders newcomers starting after you', () => {
    expect(cyclicAfter(['a', 'b', 'me', 'c', 'd'], 'me')).toEqual(['c', 'd', 'a', 'b'])
  })
})

describe('tableRadius', () => {
  it('is half size for up to three people and full size from eight', () => {
    expect(tableRadius(1, 360, 90)).toBe(180)
    expect(tableRadius(3, 360, 90)).toBe(180)
    expect(tableRadius(8, 360, 90)).toBe(360)
    expect(tableRadius(12, 360, 90)).toBe(360)
  })
  it('grows steadily in between', () => {
    const sizes = [3, 4, 5, 6, 7, 8].map(n => tableRadius(n, 360, 60))
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThan(sizes[i - 1])
  })
  it('keeps the seats clear of the middle on a small screen', () => {
    // A small window: half size would put the seat across from you on top of the room code.
    expect(tableRadius(2, 171, 56)).toBe(112)
    expect(tableRadius(2, 100, 56)).toBe(100)
  })
  it('never squeezes neighbours together on a small screen', () => {
    const r = tableRadius(5, 400, 90)
    const gap = 2 * r * Math.sin(Math.PI / 5)
    expect(gap).toBeGreaterThanOrEqual(90 * 2.3 - 1e-9)
    expect(tableRadius(12, 200, 90)).toBe(200)
  })
})

describe('Table', () => {
  const run = (t: Table, seconds = 3) => {
    for (let i = 0; i < seconds * 60; i++) t.step(1 / 60)
  }

  it('settles everyone on their seats', () => {
    const t = new Table()
    t.sync(['me', 'a', 'b'], 'me')
    run(t)
    expect(t.step(1 / 60)).toBe(false)
    close(t.seats.get('me')!.angle.x, 0)
    const angles = ['a', 'b'].map(id => t.seats.get(id)!.angle.x).sort()
    close(angles[0], slot(1, 3))
    close(angles[1], slot(2, 3))
  })

  it('fades out whoever leaves, then forgets them', () => {
    const t = new Table()
    t.sync(['me', 'a', 'b'], 'me')
    run(t)
    t.sync(['me', 'b'], 'me')
    expect(t.seats.get('a')!.leaving).toBe(true)
    run(t)
    expect(t.seats.has('a')).toBe(false)
    close(t.seats.get('b')!.angle.x, Math.PI)
  })

  it('never lets anyone pass through your seat, and never overshoots', () => {
    const t = new Table()
    t.sync(['me', 'a'], 'me')
    run(t)
    t.sync(['me', 'a', 'b', 'c', 'd'], 'me')
    for (let i = 0; i < 240; i++) {
      t.step(1 / 60)
      for (const s of t.seats.values()) {
        if (s.id === 'me') continue
        expect(s.angle.x).toBeGreaterThan(0)
        expect(s.angle.x).toBeLessThan(TAU)
      }
    }
  })

  it('retargets mid-move without a jump', () => {
    const t = new Table()
    t.sync(['me', 'a'], 'me')
    run(t)
    t.sync(['me', 'a', 'b'], 'me')
    for (let i = 0; i < 6; i++) t.step(1 / 60)
    const before = t.seats.get('a')!.angle.x
    t.sync(['me', 'a', 'b', 'c'], 'me')
    t.step(1 / 60)
    expect(Math.abs(t.seats.get('a')!.angle.x - before)).toBeLessThan(0.05)
  })
})
