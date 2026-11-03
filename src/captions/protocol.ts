/**
 * Captions between people: what goes over the peer connection's captions
 * channel (a second data channel, ordered and reliable, beside the audio's;
 * see net/session.ts and native/internal/engine/link.go). One JSON object a
 * message:
 *
 *   { v: 1, s: <sender's run>, u: <phrase>, t: "the words so far", f: <finished> }
 *
 * `u` counts the sender's phrases; each update of a phrase carries all of
 * its words so far, so a lost or late one is made good by the next, and
 * `f` says it's done. `s` is a random number for this run of the sender's
 * captions, so a rejoin (which counts from 0 again) isn't taken for old news.
 *
 * Everything that comes in is someone else's, so it's checked: size, types,
 * no control characters, and at most so many a second from anyone.
 */

export const CAPTION_VERSION = 1
/** The longest phrase that goes out, characters (a long one keeps its end). */
export const MAX_CAPTION_TEXT = 400
/** The most a message may be, as received. */
export const MAX_CAPTION_MESSAGE = 2048

export interface CaptionMsg {
  /** The sender's run of captions. */
  s: number
  /** Which phrase. */
  u: number
  t: string
  /** Finished. */
  f: boolean
}

/** Text as it may be shown: no control characters, single spaces, not too long (the end kept). */
export function cleanText(text: string): string {
  const t = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim()
  if (t.length <= MAX_CAPTION_TEXT) return t
  const tail = t.slice(t.length - MAX_CAPTION_TEXT)
  const space = tail.indexOf(' ')
  return space >= 0 && space < 40 ? tail.slice(space + 1) : tail
}

export function encodeCaption(m: CaptionMsg): string {
  return JSON.stringify({ v: CAPTION_VERSION, s: m.s, u: m.u, t: cleanText(m.t), f: m.f })
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0x7fffffff

/** Someone's message, if it's one: null for anything else. */
export function decodeCaption(data: unknown): CaptionMsg | null {
  if (typeof data !== 'string' || data.length > MAX_CAPTION_MESSAGE) return null
  let m: unknown
  try {
    m = JSON.parse(data)
  } catch {
    return null
  }
  if (!m || typeof m !== 'object') return null
  const r = m as Record<string, unknown>
  if (r.v !== CAPTION_VERSION || !isCount(r.s) || !isCount(r.u) || typeof r.t !== 'string' || typeof r.f !== 'boolean') return null
  return { s: r.s, u: r.u, t: cleanText(r.t), f: r.f }
}

/** A token bucket: `rate` a second, bursts of `burst`. */
export class RateLimit {
  private tokens: number
  private at = 0

  constructor(
    private rate: number,
    private burst: number
  ) {
    this.tokens = burst
  }

  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate)
    this.at = now
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}
