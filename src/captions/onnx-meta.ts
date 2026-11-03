/**
 * An ONNX model's metadata_props (the key/value pairs an exporter writes:
 * sherpa-onnx puts a streaming model's chunk sizes and cache shapes there),
 * read straight from the file. ONNX Runtime Web doesn't hand them over, and
 * the file is a protobuf ModelProto whose top-level fields are easy to walk:
 * metadata_props is field 14, each a StringStringEntryProto (key 1, value 2);
 * everything else is skipped by its length, the graph included.
 */

function varint(b: Uint8Array, at: { i: number }): number {
  let v = 0
  let mul = 1
  for (let n = 0; n < 10; n++) {
    if (at.i >= b.length) throw new Error('model: cut short')
    const byte = b[at.i++]
    v += (byte & 0x7f) * mul
    if (byte < 0x80) return v
    mul *= 128
  }
  throw new Error('model: bad varint')
}

function skip(b: Uint8Array, at: { i: number }, wire: number) {
  if (wire === 0) varint(b, at)
  else if (wire === 1) at.i += 8
  else if (wire === 2) {
    const n = varint(b, at)
    at.i += n
  }
  else if (wire === 5) at.i += 4
  else throw new Error(`model: wire type ${wire}`)
  if (at.i > b.length) throw new Error('model: cut short')
}

export function onnxMetadata(buf: ArrayBuffer | Uint8Array): Map<string, string> {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  const out = new Map<string, string>()
  const dec = new TextDecoder()
  const at = { i: 0 }
  while (at.i < b.length) {
    const tag = varint(b, at)
    if (tag >>> 3 !== 14 || (tag & 7) !== 2) {
      skip(b, at, tag & 7)
      continue
    }
    const len = varint(b, at)
    const end = at.i + len
    if (end > b.length) throw new Error('model: cut short')
    let key = ''
    let value = ''
    while (at.i < end) {
      const t = varint(b, at)
      if ((t & 7) === 2 && (t >>> 3 === 1 || t >>> 3 === 2)) {
        const n = varint(b, at)
        const s = dec.decode(b.subarray(at.i, at.i + n))
        at.i += n
        if (t >>> 3 === 1) key = s
        else value = s
      } else skip(b, at, t & 7)
    }
    at.i = end
    out.set(key, value)
  }
  return out
}

/** What a sherpa-onnx streaming NeMo CTC export says about itself, checked. */
export interface StreamingCtcMeta {
  window: number
  shift: number
  /** cache_last_channel's and cache_last_time's shapes, batch of one. */
  channel: [number, number, number, number]
  time: [number, number, number, number]
}

export function streamingCtcMeta(meta: Map<string, string>): StreamingCtcMeta {
  const n = (k: string) => {
    const v = Number(meta.get(k))
    if (!Number.isInteger(v) || v <= 0 || v > 1 << 16) throw new Error(`model: no ${k}`)
    return v
  }
  if ((meta.get('normalize_type') ?? '') !== '') throw new Error(`model: features normalised (${meta.get('normalize_type')}), which this doesn't do`)
  if (n('subsampling_factor') !== 8) throw new Error('model: not 8× subsampling')
  const window = n('window_size')
  const shift = n('chunk_shift')
  if (shift > window) throw new Error('model: chunks with gaps between them')
  return {
    window,
    shift,
    channel: [1, n('cache_last_channel_dim1'), n('cache_last_channel_dim2'), n('cache_last_channel_dim3')],
    time: [1, n('cache_last_time_dim1'), n('cache_last_time_dim2'), n('cache_last_time_dim3')]
  }
}
