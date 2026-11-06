/**
 * Captions as they're shown: a person's phrases run together as one piece of
 * flowing text, newest last, rather than one phrase a line. Each part carries
 * its own opacity so older phrases can fade, by how many phrases back they
 * are (`fade` per phrase). The live phrase is the last one.
 */

export interface CaptionPart {
  /** Its words, with a leading space when one is needed to join it to the part before. */
  text: string
  /** The phrase still being said. */
  live: boolean
  opacity: number
}

/** The faintest an old phrase gets, however strong the fading. */
const MIN_OPACITY = 0.2

export function captionParts(lines: string[], live: boolean, fade: number): CaptionPart[] {
  const strength = Number.isFinite(fade) ? Math.max(0, Math.min(1, fade)) : 0
  const out: CaptionPart[] = []
  let prev = ''
  for (let i = 0; i < lines.length; i++) {
    const phrase = lines[i] ?? ''
    if (!phrase) continue
    // One space between phrases, unless one of them already brings it.
    const gap = prev && !/\s$/.test(prev) && !/^\s/.test(phrase) ? ' ' : ''
    out.push({
      text: gap + phrase,
      live: live && i === lines.length - 1,
      // The newest is age 0; each one before it is another phrase older.
      opacity: Math.max(MIN_OPACITY, 1 - strength * (lines.length - 1 - i))
    })
    prev = phrase
  }
  return out
}
