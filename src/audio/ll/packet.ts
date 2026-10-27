/**
 * The low-latency engine's packet: one datagram on an unordered,
 * no-retransmit data channel.
 *
 *   u8  version (1)
 *   u8  flags   bit 0: a capture-time stamp follows
 *   u8  frame count n
 *   [f64 capture time of the newest frame, ms since the epoch]   if flagged
 *   n × { u32 timestamp (sender's 48 kHz sample clock), u16 length, bytes }
 *
 * Frames run oldest first; the last is the new one, the others are repeats
 * of the frames before it (redundancy), so a lost packet costs nothing as
 * long as the next one arrives.
 */

export const PACKET_VERSION = 1
const FLAG_CAPTURE = 1

export interface Frame {
  ts: number
  data: Uint8Array
}

export interface Packet {
  frames: Frame[]
  /** Wall-clock capture time of the newest frame, if the sender stamped it. */
  captureMs: number | null
}

export function encodePacket(frames: readonly Frame[], captureMs: number | null = null): ArrayBuffer {
  let size = 3 + (captureMs === null ? 0 : 8)
  for (const f of frames) size += 6 + f.data.byteLength
  const buf = new ArrayBuffer(size)
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)
  view.setUint8(0, PACKET_VERSION)
  view.setUint8(1, captureMs === null ? 0 : FLAG_CAPTURE)
  view.setUint8(2, frames.length)
  let o = 3
  if (captureMs !== null) {
    view.setFloat64(o, captureMs, true)
    o += 8
  }
  for (const f of frames) {
    view.setUint32(o, f.ts >>> 0, true)
    view.setUint16(o + 4, f.data.byteLength, true)
    bytes.set(f.data, o + 6)
    o += 6 + f.data.byteLength
  }
  return buf
}

/** Null for anything that isn't a well-formed packet. */
export function decodePacket(buf: ArrayBuffer): Packet | null {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < 3) return null
  const view = new DataView(buf)
  if (view.getUint8(0) !== PACKET_VERSION) return null
  const flags = view.getUint8(1)
  const n = view.getUint8(2)
  let o = 3
  let captureMs: number | null = null
  if (flags & FLAG_CAPTURE) {
    if (buf.byteLength < o + 8) return null
    captureMs = view.getFloat64(o, true)
    o += 8
  }
  const frames: Frame[] = []
  for (let i = 0; i < n; i++) {
    if (buf.byteLength < o + 6) return null
    const ts = view.getUint32(o, true)
    const len = view.getUint16(o + 4, true)
    if (buf.byteLength < o + 6 + len) return null
    frames.push({ ts, data: new Uint8Array(buf, o + 6, len) })
    o += 6 + len
  }
  return { frames, captureMs }
}

/**
 * Turns the sender's 32-bit sample counter into a number that keeps going
 * up past the wrap (every ~25 hours at 48 kHz).
 */
export class Unwrapper {
  private last = -1
  private lastFull = 0
  unwrap(ts: number): number {
    if (this.last < 0) {
      this.last = this.lastFull = ts
      return ts
    }
    let d = ts - this.last
    if (d > 0x8000_0000) d -= 0x1_0000_0000
    else if (d < -0x8000_0000) d += 0x1_0000_0000
    const full = this.lastFull + d
    if (d > 0) {
      this.last = ts
      this.lastFull = full
    }
    return full
  }
}
