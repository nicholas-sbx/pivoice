import { describe, expect, it } from 'vitest'
import { MIN_TILE_H, TILE_GAP, layoutTiles } from '../src/lib/tiles'

// A phone in portrait: what's left of the screen under the top bar and above the call controls.
const PHONE = { w: 344, h: 560 }

describe('tiles', () => {
  it('gives one or two people big tiles, stacked, never much taller than wide', () => {
    const one = layoutTiles(1, PHONE.w, PHONE.h)
    expect(one).toMatchObject({ cols: 1, w: 344, h: Math.floor(344 * 1.3), row: false, scroll: false })
    const two = layoutTiles(2, PHONE.w, PHONE.h)
    expect(two.cols).toBe(1)
    expect(two.h).toBe(Math.floor((PHONE.h - TILE_GAP) / 2))
    expect(two.row).toBe(false)
  })

  it('fills the screen rather than leaving it empty', () => {
    for (let n = 1; n <= 12; n++) {
      const t = layoutTiles(n, PHONE.w, PHONE.h)
      const rows = Math.ceil(n / t.cols)
      const used = rows * t.h + (rows - 1) * TILE_GAP
      const across = t.cols * t.w + (t.cols - 1) * TILE_GAP
      expect(t.scroll).toBe(false)
      // Either it's as tall as the space, or as wide (tiles stop a little past square).
      expect(used >= PHONE.h - rows - 1 || across >= PHONE.w - t.cols - 1).toBe(true)
    }
  })

  it('turns into a list of rows when there are many, and scrolls only past that', () => {
    const twelve = layoutTiles(12, PHONE.w, PHONE.h)
    expect(twelve.h).toBeGreaterThanOrEqual(MIN_TILE_H)
    const short = layoutTiles(12, PHONE.w, 300)
    expect(short.scroll).toBe(true)
    expect(short.h).toBe(MIN_TILE_H)
    expect(short.row).toBe(true)
  })

  it('goes wide in landscape', () => {
    const t = layoutTiles(4, 700, 260)
    expect(t.cols).toBeGreaterThan(1)
    expect(t.scroll).toBe(false)
  })

  it('keeps the avatar inside the tile', () => {
    for (const [n, w, h] of [
      [1, 344, 560],
      [6, 344, 560],
      [12, 344, 560],
      [12, 344, 200],
      [3, 700, 260]
    ]) {
      const t = layoutTiles(n, w, h)
      expect(t.avatar).toBeLessThanOrEqual(t.h)
      expect(t.avatar % 2).toBe(0)
    }
  })
})
