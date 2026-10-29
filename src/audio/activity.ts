/**
 * Who's making a sound, at two levels, for the rings round people's faces:
 *
 *  - speaking: louder than SPEAKING_RMS (about −40 dBFS), the full ring;
 *  - audible: anything above silence at all (about −80 dBFS: a breath, a
 *    room, a fan, someone talking very quietly), a thin one, so you can
 *    see someone's mic is coming through even when they're not talking.
 *
 * Each holds for a moment after the last block that crossed it, so the rings
 * don't flicker between words. Fed block levels (RMS) from wherever the audio
 * is: the browser's analysers (AudioEngine) or the app's level messages.
 */

/** RMS above this counts as talking (about −40 dBFS). */
export const SPEAKING_RMS = 0.01
/** Above this, something's coming through: anything but digital silence (about −80 dBFS). */
export const AUDIBLE_RMS = 0.0001
/** Keep a ring lit this long after the last block that lit it. */
export const SPEAKING_HOLD_MS = 300

export interface Activity {
  speaking: Set<string>
  /** Making any sound at all (speaking ones included). */
  audible: Set<string>
}

export class ActivityTracker {
  private loudAt = new Map<string, number>()
  private heardAt = new Map<string, number>()

  hear(id: string, rms: number, now: number) {
    if (rms > SPEAKING_RMS) this.loudAt.set(id, now)
    if (rms > AUDIBLE_RMS) this.heardAt.set(id, now)
  }

  forget(id: string) {
    this.loudAt.delete(id)
    this.heardAt.delete(id)
  }

  read(now: number, include: (id: string) => boolean = () => true): Activity {
    const pick = (m: Map<string, number>) => {
      const out = new Set<string>()
      for (const [id, at] of m) if (now - at < SPEAKING_HOLD_MS && include(id)) out.add(id)
      return out
    }
    return { speaking: pick(this.loudAt), audible: pick(this.heardAt) }
  }
}

/** Same people in both? (So the UI only updates when someone's ring changes.) */
export function sameActivity(a: Activity, b: Activity): boolean {
  const same = (x: Set<string>, y: Set<string>) => x.size === y.size && [...x].every(id => y.has(id))
  return same(a.speaking, b.speaking) && same(a.audible, b.audible)
}
