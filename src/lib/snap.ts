import type { Directive } from 'vue'

/**
 * v-snap: keeps an element on whole device pixels, so its text is drawn
 * crisp rather than resampled. Anything centred lands on a half pixel
 * whenever its width and its container's don't share a parity (the call
 * controls, the panels above them, every tooltip), and right-aligned
 * things inherit their neighbours' fractions; CSS can't round those away.
 *
 * It measures where the element ended up and nudges it the rest of the way
 * with the separate `translate` property (so a `transform` animation on the
 * same element still works), again whenever its size or the window changes.
 * Snapped elements inside it are redone after it, since moving it moves them.
 */

const snapped = new Set<HTMLElement>()
let listening = false

export function snapNow(el: HTMLElement) {
  el.style.translate = ''
  const r = el.getBoundingClientRect()
  // The window it's in: a pop-out's screen can have another scale than the page's.
  const dpr = (el.ownerDocument.defaultView ?? window).devicePixelRatio || 1
  const dx = Math.round(r.left * dpr) / dpr - r.left
  const dy = Math.round(r.top * dpr) / dpr - r.top
  const small = (v: number) => Math.abs(v) < 0.005
  el.style.translate = small(dx) && small(dy) ? '' : `${dx.toFixed(3)}px ${dy.toFixed(3)}px`
  for (const inner of el.querySelectorAll<HTMLElement>('[data-snap]')) snapNow(inner)
}

function snapAll() {
  // Outermost first: snapNow redoes the ones inside.
  for (const el of snapped) if (!el.parentElement?.closest('[data-snap]')) snapNow(el)
}

const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => entries.forEach(e => snapNow(e.target as HTMLElement)))

export const vSnap: Directive<HTMLElement> = {
  mounted(el) {
    el.dataset.snap = ''
    snapped.add(el)
    if (!listening) {
      listening = true
      addEventListener('resize', snapAll)
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
