import { describe, expect, it } from 'vitest'
import { visibleBox } from '../src/lib/tableView'

/** A box the way an element reports itself: a position in the window, and a size. */
const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height })

describe('visibleBox', () => {
  it('leaves a box that fits exactly as it is', () => {
    expect(visibleBox(box(100, 50, 400, 300), 1112, 688)).toEqual({ x: 0, y: 0, w: 400, h: 300 })
  })

  it('takes a box bigger than the window down to the part you can see', () => {
    // The report: a room laid out in 1157×740 starting under a 272 px sidebar,
    // inside a 1112×688 window. Its middle was the window's bottom right.
    expect(visibleBox(box(272, 112, 1157, 740), 1112, 688)).toEqual({ x: 0, y: 0, w: 840, h: 576 })
  })

  it('says where the seen part starts when the box begins off screen', () => {
    expect(visibleBox(box(-120, -40, 500, 400), 1112, 688)).toEqual({ x: 120, y: 40, w: 380, h: 360 })
  })

  it('keeps the part past the far edges out of it', () => {
    expect(visibleBox(box(1000, 600, 1157, 740), 1112, 688)).toEqual({ x: 0, y: 0, w: 112, h: 88 })
    // Off both a side and an end at once.
    expect(visibleBox(box(-10, -10, 200, 200), 1112, 688)).toEqual({ x: 10, y: 10, w: 190, h: 190 })
  })

  it('has nothing left of a box that is entirely off screen', () => {
    expect(visibleBox(box(1400, 800, 300, 300), 1112, 688)).toEqual({ x: 0, y: 0, w: 0, h: 0 })
    expect(visibleBox(box(-400, 0, 300, 300), 1112, 688)).toEqual({ x: 400, y: 0, w: 0, h: 300 })
  })

  it('keeps fractions, so the middle of what is seen stays the middle', () => {
    expect(visibleBox(box(10.5, 0.25, 1101.5, 687.75), 1112, 688)).toEqual({ x: 0, y: 0, w: 1101.5, h: 687.75 })
  })
})
