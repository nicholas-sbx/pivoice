/**
 * The low-latency engine's packet: one datagram on an unordered,
 * no-retransmit data channel.
 *
 *   u8  version (1)
 *   u8  flags   bit 0: a capture-time stamp follows
 *               bit 1: frames are raw 16-bit little-endian PCM, not Opus
 *   u8  frame count n
 *   [f64 capture time of the newest frame, ms since the epoch]   if flagged
 *   n × { u32 timestamp (sender's 48 kHz sample clock), u16 length, bytes }
 *
 * Frames run oldest first; the last is the new one, the others are repeats
 * of the frames before it (redundancy), so a lost packet costs nothing as
 * long as the next one arrives.
 *
 * Pings share the channel, with a first byte no audio packet has (so a
 * client that predates them just drops them):
 *
 *   u8  PING or PONG
 *   f64 the pinger's clock when it sent the ping, ms (a pong echoes it)
 */

export const PACKET_VERSION = 1
export const PING = 0xf0
export const PONG = 0xf1
const FLAG_CAPTURE = 1
const FLAG_PCM = 2

export interface Frame {
  ts: number
  data: Uint8Array
}

export interface Packet {
  frames: Frame[]
  /** Wall-clock capture time of the newest frame, if the sender stamped it. */
  captureMs: number | null
  /** Raw PCM frames (see pcmToBytes), not Opus. */
  pcm: boolean
}

export function encodePacket(frames: readonly Frame[], captureMs: number | null = null, pcm = false): ArrayBuffer {
  let size = 3 + (captureMs === null ? 0 : 8)
  for (const f of frames) size += 6 + f.data.byteLength
  const buf = new ArrayBuffer(size)
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)
  view.setUint8(0, PACKET_VERSION)
  view.setUint8(1, (captureMs === null ? 0 : FLAG_CAPTURE) | (pcm ? FLAG_PCM : 0))
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
  return { frames, captureMs, pcm: (flags & FLAG_PCM) !== 0 }
}

export function encodePing(kind: typeof PING | typeof PONG, sentMs: number): ArrayBuffer {
  const buf = new ArrayBuffer(9)
  const view = new DataView(buf)
  view.setUint8(0, kind)
  view.setFloat64(1, sentMs, true)
  return buf
}

/** A ping or pong, or null for anything else. */
export function decodePing(buf: ArrayBuffer): { kind: typeof PING | typeof PONG; sentMs: number } | null {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength !== 9) return null
  const view = new DataView(buf)
  const kind = view.getUint8(0)
  if (kind !== PING && kind !== PONG) return null
  return { kind, sentMs: view.getFloat64(1, true) }
}

/** Float samples → 16-bit little-endian PCM bytes. */
export function pcmToBytes(pcm: Float32Array): Uint8Array {
  const out = new Uint8Array(pcm.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]))
    view.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true)
  }
  return out
}

/** 16-bit little-endian PCM bytes → float samples. */
export function bytesToPcm(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const n = bytes.byteLength >> 1
  const out = new Float32Array(n)
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2)
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 0x8000
  return out
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
