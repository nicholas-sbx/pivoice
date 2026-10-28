/**
 * The people list on small screens: a grid of tiles sized to the room it
 * has and the number of people in it, so there's never a screen of empty
 * space under a short list, nor a long scroll for a few people.
 *
 * Every column count that fits is tried; the one giving each tile the most
 * usable area wins. A tile's contents can only use so much width for its
 * height (an avatar and a name), so a long thin strip scores less than its
 * area. Tiles are never much taller than they are wide (a lone tile on a
 * tall phone isn't a wall), and never shorter than a comfortable list
 * row: past that, the list keeps rows of that height and scrolls.
 */

export interface TileLayout {
  cols: number
  /** Tile size, whole pixels. */
  w: number
  h: number
  /** Too many to fit at the smallest size: the list scrolls. */
  scroll: boolean
  /** A row (avatar beside the name) rather than a tile (avatar above it). */
  row: boolean
  avatar: number
}

export const TILE_GAP = 8

/**
 * Room around the tiles: generous with a few people, so nothing sits hard
 * against the screen's edge, and tightening as the call fills up, when
 * every pixel goes to the tiles. Edge is each side (and the top); gap is
 * between tiles.
 */
export function tileSpacing(n: number): { edge: number; gap: number } {
  if (n <= 2) return { edge: 24, gap: 16 }
  if (n <= 4) return { edge: 20, gap: 14 }
  if (n <= 8) return { edge: 16, gap: 12 }
  return { edge: 12, gap: TILE_GAP }
}
/** A list row: an avatar, a name and its icons, comfortably tappable. */
export const MIN_TILE_H = 60
/** Narrower than this and names get cut to nothing. */
const MIN_TILE_W = 110
/** Below this height a tile lays out as a row. */
const ROW_BELOW = 120
const MAX_COLS = 4
/** How much wider than tall a tile's contents can use. */
const USABLE_ASPECT = 2.2
/** How much taller than wide a tile may be: a little, so one or two people aren't adrift in empty screen. */
const MAX_TALL = 1.3

export function layoutTiles(n: number, width: number, height: number, gap = TILE_GAP): TileLayout {
  const count = Math.max(1, n)
  let best: TileLayout | null = null
  let bestArea = -1
  for (let cols = 1; cols <= Math.min(count, MAX_COLS); cols++) {
    const w = (width - (cols - 1) * gap) / cols
    if (w < MIN_TILE_W && cols > 1) break
    const rows = Math.ceil(count / cols)
    const fit = (height - (rows - 1) * gap) / rows
    const h = Math.min(fit, w * MAX_TALL)
    // Tiles that would be shorter than a row don't fit at all; they're only a fallback.
    const area = h >= MIN_TILE_H ? Math.min(w, h * USABLE_ASPECT) * h : -1
    if (area > bestArea) {
      bestArea = area
      best = finish(cols, w, h, false)
    }
  }
  if (best && bestArea > 0) return best
  // Doesn't fit even as one column of rows: rows of the smallest size, scrolling.
  const cols = width >= 2 * 260 + gap ? 2 : 1
  return finish(cols, (width - (cols - 1) * gap) / cols, MIN_TILE_H, true)
}

function finish(cols: number, w: number, h: number, scroll: boolean): TileLayout {
  const W = Math.floor(w)
  const H = Math.floor(h)
  const row = H < ROW_BELOW
  // Even, so the avatar centres on a whole pixel.
  const size = row ? Math.min(H - 24, 56, W * 0.28) : Math.min(H * 0.5, W * 0.45, 112)
  const avatar = 2 * Math.round(Math.max(32, size) / 2)
  return { cols, w: W, h: H, scroll, row, avatar }
}
