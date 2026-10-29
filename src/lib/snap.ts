import type { Directive } from 'vue'

/**
 * v-snap: keeps an element on whole device pixels, so its text is drawn
 * crisp rather than resampled. Anything centred lands on a half pixel
 * whenever its width and its container's don't share a parity (the call
 * controls, the panels above them, every tooltip), and right-aligned
 * things inherit their neighbours' fractions; CSS can't round those away.
 *
 * It measures where the element ended up and nudges it the rest of the way
 * with a margin: layout, never a transform. (A transform, even
 * `translate`, makes WebKit, the app's window on Linux and macOS, draw the
 * element into a layer of its own and then shift that layer, which smears
 * the text worse than the half pixel did.) Which margin moves it depends on
 * how it's placed (left or right, top or bottom, centred), so it tries one,
 * then the other, and scales the nudge if the element only moved part of
 * the way (centred things move half). Again whenever its size or the
 * window changes, or a transition around it ends (one measured mid-way, a
 * pressed button's scale or a tooltip's slide-in, lands off); snapped
 * elements inside it are redone after it.
 */

const snapped = new Set<HTMLElement>()
let listening = false

const SIDES = {
  x: ['marginLeft', 'marginRight'],
  y: ['marginTop', 'marginBottom']
} as const

function viewOf(el: HTMLElement): Window {
  return el.ownerDocument.defaultView ?? window
}

function at(el: HTMLElement, axis: 'x' | 'y'): number {
  const r = el.getBoundingClientRect()
  return axis === 'x' ? r.left : r.top
}

function nudge(el: HTMLElement, axis: 'x' | 'y', delta: number) {
  const from = at(el, axis)
  for (const [i, side] of SIDES[axis].entries()) {
    const sign = i === 0 ? 1 : -1
    const base = parseFloat(viewOf(el).getComputedStyle(el)[side]) || 0
    el.style[side] = `${base + sign * delta}px`
    const moved = at(el, axis) - from
    if (Math.abs(moved) > 1e-4) {
      // Centred: a margin moves it half as far. Scale up to land exactly.
      if (Math.abs(moved - delta) > 1e-3) el.style[side] = `${base + (sign * delta * delta) / moved}px`
      return
    }
    el.style[side] = ''
  }
}

export function snapNow(el: HTMLElement) {
  for (const side of [...SIDES.x, ...SIDES.y]) el.style[side] = ''
  // The window it's in: a pop-out's screen can have another scale than the page's.
  const dpr = viewOf(el).devicePixelRatio || 1
  // Layout works in 1/64 px, so a nudge can land a hair off (a centred one
  // especially): a second pass from where it got to settles it.
  for (let pass = 0; pass < 3; pass++) {
    const r = el.getBoundingClientRect()
    const dx = Math.round(r.left * dpr) / dpr - r.left
    const dy = Math.round(r.top * dpr) / dpr - r.top
    const x = Math.abs(dx) > 0.005
    const y = Math.abs(dy) > 0.005
    if (!x && !y) break
    if (x) nudgeMore(el, 'x', dx)
    if (y) nudgeMore(el, 'y', dy)
  }
  for (const inner of el.querySelectorAll<HTMLElement>('[data-snap]')) snapNow(inner)
}

// A nudge on top of the one already there: whichever margin it set, it adds to that one.
function nudgeMore(el: HTMLElement, axis: 'x' | 'y', delta: number) {
  const set = SIDES[axis].find(side => el.style[side] !== '')
  if (!set) return nudge(el, axis, delta)
  const from = at(el, axis)
  const base = parseFloat(el.style[set])
  const sign = set === SIDES[axis][0] ? 1 : -1
  el.style[set] = `${base + sign * delta}px`
  const moved = at(el, axis) - from
  if (Math.abs(moved) > 1e-4 && Math.abs(moved - delta) > 1e-3) el.style[set] = `${base + (sign * delta * delta) / moved}px`
}

function snapAll() {
  // Outermost first: snapNow redoes the ones inside.
  for (const el of snapped) if (!el.parentElement?.closest('[data-snap]')) snapNow(el)
}

// A transition on it or around it moved it: whatever was measured during it is off now.
function settled(e: Event) {
  const t = e.target
  if (!(t instanceof HTMLElement)) return
  for (const el of snapped) if (t === el || t.contains(el)) snapNow(el)
}

// A margin it sets itself doesn't resize the element, so this only fires for real changes.
const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => entries.forEach(e => snapNow(e.target as HTMLElement)))

export const vSnap: Directive<HTMLElement> = {
  mounted(el) {
    el.dataset.snap = ''
    snapped.add(el)
    if (!listening) {
      listening = true
      addEventListener('resize', snapAll)
      addEventListener('transitionend', settled, true)
    }
    // After the first layout (and any panel opening around it) has settled.
    requestAnimationFrame(() => snapNow(el))
    observer?.observe(el)
  },
  unmounted(el) {
    snapped.delete(el)
    observer?.unobserve(el)
  }
}
