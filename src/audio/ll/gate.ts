/**
 * Our DTX: skip a frame once you've been below the threshold for a moment.
 * Each frame decides from its own level, so the first frame with any sound
 * in it goes out (nothing waits on a detector), and the hangover keeps the
 * tails of words. The app's sender uses the same gate (ll.Gate, gate.go).
 *
 * **The look-back.** The far end's jitter buffer goes idle in a silence and
 * starts the next talkspurt when its first frame is due, at whatever point
 * of that frame the playback clock has reached by then: on average halfway
 * in. Started cold, that's a jump from nothing to the middle of the
 * attack, which is the click people heard at the start of every sentence.
 * So the gate keeps the last PREROLL frames it held back, and the first
 * frame it lets through after a silence goes out with them, in the same
 * packet, where repeats would go. They were captured already, so nothing
 * waits for them, and they're under the threshold, so the far end starts
 * on the quiet just before the sound and plays the attack whole, on time.
 */

/** Frames held back for the look-back: two 128-sample frames (5.3 ms), and with the new one a full packet (MAX_PACKET_FRAMES). */
export const PREROLL = 2

export interface GateFrame {
  ts: number
  pcm: Float32Array
}

const NONE: readonly GateFrame[] = []

export class SilenceGate {
  private quietFor = 0
  private held: GateFrame[] = []

  /** Whether this frame goes out. If it's the first after a silence, `lead()` then has the frames just before it. */
  pass(ts: number, pcm: Float32Array, thresholdDb: number, hangoverMs: number): boolean {
    let sum = 0
    for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i]
    const db = 10 * Math.log10(sum / pcm.length + 1e-12)
    if (db >= thresholdDb) this.quietFor = 0
    else this.quietFor += pcm.length
    const last = this.held[this.held.length - 1]
    // Only frames that run straight up to this one (none from before a mute, say).
    if (last && last.ts + last.pcm.length !== ts) this.held = []
    if (this.quietFor <= hangoverMs * 48) return true
    this.held.push({ ts, pcm })
    if (this.held.length > PREROLL) this.held.shift()
    return false
  }

  /** The frames held back just before the one `pass` let through, oldest first; then forgets them. */
  lead(): readonly GateFrame[] {
    if (!this.held.length) return NONE
    const l = this.held
    this.held = []
    return l
  }
}
