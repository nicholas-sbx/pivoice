import { RateLimit, decodeCaption, type CaptionMsg } from './protocol'

/**
 * Everyone's captions, as they're shown: per person, their last few
 * finished phrases and the one they're in the middle of. Fed by the
 * captions channel (someone else's words, checked by decodeCaption and held
 * to a rate) and by your own recogniser.
 */

/** Finished phrases kept per person (more than any setting shows). */
const KEEP = 6
/** Anyone's captions: this many messages a second, in bursts of this many. */
const RATE = 25
const BURST = 50

export interface CaptionView {
  /** Oldest first: finished phrases, then the one being said (if any). */
  lines: string[]
  /** Last changed (ms, performance.now()). */
  at: number
  /** Still mid-phrase. */
  live: boolean
}

interface Person {
  s: number
  u: number
  finals: string[]
  partial: string
  at: number
  limit: RateLimit
}

export class CaptionBoard {
  private people = new Map<string, Person>()

  /** A message off the wire from `id`. True if it changed what's shown. */
  receive(id: string, data: unknown, now: number): boolean {
    const p = this.person(id, now)
    if (!p.limit.take(now)) return false
    const m = decodeCaption(data)
    return m ? this.apply(id, m, now) : false
  }

  /** One of ours, or one already checked. True if it changed what's shown. */
  apply(id: string, m: CaptionMsg, now: number): boolean {
    const p = this.person(id, now)
    if (m.s !== p.s) {
      // Their captions started again (a rejoin): what we had is from before.
      p.s = m.s
      p.u = m.u
      p.finals = []
      p.partial = ''
    } else if (m.u < p.u) return false
    if (m.u > p.u) {
      // A phrase we never saw finish: keep what we had of it.
      if (p.partial) this.finish(p, p.partial)
      p.partial = ''
      p.u = m.u
    }
    if (m.f) {
      if (m.t) this.finish(p, m.t)
      p.partial = ''
      // Whatever comes next is a new phrase.
      p.u = m.u + 1
    } else {
      if (m.t === p.partial) return false
      p.partial = m.t
    }
    p.at = now
    return true
  }

  private finish(p: Person, text: string) {
    p.finals.push(text)
    if (p.finals.length > KEEP) p.finals.shift()
  }

  private person(id: string, now: number): Person {
    let p = this.people.get(id)
    if (!p) {
      p = { s: -1, u: 0, finals: [], partial: '', at: now, limit: new RateLimit(RATE, BURST) }
      this.people.set(id, p)
    }
    return p
  }

  view(id: string): CaptionView | null {
    const p = this.people.get(id)
    if (!p || (!p.finals.length && !p.partial)) return null
    return { lines: p.partial ? [...p.finals, p.partial] : [...p.finals], at: p.at, live: !!p.partial }
  }

  /** Clear what's older than `maxAgeMs` (their captions go once they've been quiet that long). Returns who changed. */
  expire(now: number, maxAgeMs: number): string[] {
    const gone: string[] = []
    for (const [id, p] of this.people) {
      if ((p.finals.length || p.partial) && now - p.at >= maxAgeMs) {
        p.finals = []
        p.partial = ''
        gone.push(id)
      }
    }
    return gone
  }

  forget(id: string) {
    this.people.delete(id)
  }

  clear() {
    this.people.clear()
  }
}
