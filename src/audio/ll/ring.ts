/**
 * A single-producer, single-consumer ring of audio frames in a
 * SharedArrayBuffer: how the low-latency engine hands audio between its
 * worklets and its worker when the page is cross-origin isolated (see
 * worker/index.ts for the headers), instead of postMessage.
 *
 * The writer fills a slot and then publishes it by bumping the write
 * count; the reader takes slots up to that count and bumps the read
 * count. Neither ever waits on the other: a full ring drops the newest
 * frame (late audio is useless anyway). The audio thread can poll it at
 * the top of every render quantum, and the worker can sleep on it with
 * Atomics.waitAsync and wake the instant a frame lands.
 *
 * Layout: Int32 [write, read] | Float64 ts × slots | Int32 length × slots |
 * Float32 samples × slots × maxFrame.
 */

const WRITE = 0
const READ = 1

export class FrameRing {
  readonly ctrl: Int32Array
  private ts: Float64Array
  private len: Int32Array
  private data: Float32Array

  constructor(
    readonly sab: SharedArrayBuffer,
    readonly slots: number,
    readonly maxFrame: number
  ) {
    this.ctrl = new Int32Array(sab, 0, 2)
    this.ts = new Float64Array(sab, 8, slots)
    this.len = new Int32Array(sab, 8 + 8 * slots, slots)
    this.data = new Float32Array(sab, 8 + 12 * slots + (slots % 2 ? 4 : 0), slots * maxFrame)
  }

  static bytes(slots: number, maxFrame: number): number {
    return 8 + 12 * slots + (slots % 2 ? 4 : 0) + 4 * slots * maxFrame
  }

  static create(slots: number, maxFrame: number): FrameRing {
    return new FrameRing(new SharedArrayBuffer(FrameRing.bytes(slots, maxFrame)), slots, maxFrame)
  }

  /** Rebuild a view on a buffer that came from elsewhere (it carries its own size). */
  static from(sab: SharedArrayBuffer, slots: number, maxFrame: number): FrameRing {
    return new FrameRing(sab, slots, maxFrame)
  }

  /** False if the ring is full or the frame too big (the frame is dropped). */
  push(ts: number, pcm: Float32Array): boolean {
    const w = Atomics.load(this.ctrl, WRITE)
    const r = Atomics.load(this.ctrl, READ)
    if (w - r >= this.slots || pcm.length > this.maxFrame) return false
    const slot = w % this.slots
    this.ts[slot] = ts
    this.len[slot] = pcm.length
    this.data.set(pcm, slot * this.maxFrame)
    Atomics.store(this.ctrl, WRITE, w + 1)
    return true
  }

  /** Hands each waiting frame to `take` (the samples are a view: copy them if you keep them). */
  drain(take: (ts: number, pcm: Float32Array) => void): number {
    const w = Atomics.load(this.ctrl, WRITE)
    let r = Atomics.load(this.ctrl, READ)
    let n = 0
    while (r < w) {
      const slot = r % this.slots
      take(this.ts[slot], this.data.subarray(slot * this.maxFrame, slot * this.maxFrame + this.len[slot]))
      r++
      n++
    }
    Atomics.store(this.ctrl, READ, r)
    return n
  }

  /** Wake a reader sleeping in waitAsync. Never blocks (safe on the audio thread). */
  notify() {
    Atomics.notify(this.ctrl, WRITE)
  }

  /** The write count, to sleep on with Atomics.waitAsync until it changes. */
  get written(): number {
    return Atomics.load(this.ctrl, WRITE)
  }
}

/** Frames bigger than this never go through a ring: 20 ms at 48 kHz. */
export const RING_MAX_FRAME = 960
export const RING_SLOTS = 64
