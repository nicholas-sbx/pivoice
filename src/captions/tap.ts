/** What the page, the caption worklet (worklet.ts) and the caption worker share about the audio between them. */

/** Samples a frame to the worker: 20 ms at 48 kHz. */
export const CAPTION_FRAME = 960
/** Frames the shared ring holds: 5 s, so a slow phrase on a slow machine loses none. */
export const CAPTION_SLOTS = 256

export interface CaptionTapOptions {
  preMs: number
  postMs: number
  maxPreMs: number
  ring?: SharedArrayBuffer
}

export type CaptionTapMessage = { on?: boolean; preMs?: number; postMs?: number; port?: MessagePort }
/** Over a MessagePort, when there's no shared memory: audio, or the end of a segment. */
export type CaptionTapFrame = { pcm: Float32Array } | { end: true }
