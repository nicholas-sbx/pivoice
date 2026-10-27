/**
 * A damped spring, stepped by hand every animation frame. Retargeting keeps
 * the current position *and* velocity, so a seat that's already sliding
 * when someone else joins bends smoothly toward its new spot instead of
 * restarting.
 */
export interface Spring {
  x: number
  v: number
  target: number
}

export interface SpringConfig {
  stiffness: number
  damping: number
}

/** Critically damped: as fast as possible without overshooting. */
export const SEAT_SPRING: SpringConfig = { stiffness: 80, damping: 2 * Math.sqrt(80) }
export const PRESENCE_SPRING: SpringConfig = { stiffness: 140, damping: 2 * Math.sqrt(140) * 0.85 }

const MAX_SUBSTEP = 1 / 240

export function spring(x: number, target = x): Spring {
  return { x, v: 0, target }
}

/** Semi-implicit Euler in small substeps, so a dropped frame doesn't blow it up. */
export function stepSpring(s: Spring, dt: number, cfg: SpringConfig) {
  let left = Math.min(dt, 0.1)
  while (left > 0) {
    const h = Math.min(left, MAX_SUBSTEP)
    const a = -cfg.stiffness * (s.x - s.target) - cfg.damping * s.v
    s.v += a * h
    s.x += s.v * h
    left -= h
  }
}

export function isSettled(s: Spring, eps = 1e-4): boolean {
  return Math.abs(s.x - s.target) < eps && Math.abs(s.v) < eps * 10
}

export function settle(s: Spring) {
  s.x = s.target
  s.v = 0
}
