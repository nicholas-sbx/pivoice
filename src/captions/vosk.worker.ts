/**
 * Captions with Vosk, in a browser: vosk-browser's WebAssembly build of
 * Vosk (Kaldi), the glue taken out of its bundle and made safe to run under
 * our CSP (scripts/vosk-glue.ts). Streaming: it recognises as the audio
 * comes, says what it has so far whenever asked, and finishes a phrase by
 * itself at a pause. One thread, the CPU's.
 */
/// <reference lib="webworker" />
import LoadVosk from 'virtual:vosk'
import { CAPTION_RATE } from './config'
import { run, type Recogniser, type WorkerConfig } from './worker-core'

/** Samples handed to Vosk at once (the worklet's frames are 320 at 16 kHz). */
const CHUNK = 4096

/** A finished phrase's words, without those it was unsure of. */
function words(json: string, minConfidence: number): string {
  try {
    const r = JSON.parse(json) as { text?: string; result?: { word: string; conf: number }[] }
    if (minConfidence > 0 && Array.isArray(r.result)) {
      return r.result
        .filter(w => w.conf >= minConfidence)
        .map(w => w.word)
        .join(' ')
    }
    return r.text ?? ''
  } catch {
    return ''
  }
}

run(async (files, _model, cfg0) => {
  const V = await LoadVosk()
  V.SetLogLevel(-1)
  const root = '/model'
  for (const [path, buf] of files) {
    const dir = path.split('/').slice(0, -1).join('/')
    V.FS.mkdirTree(dir ? `${root}/${dir}` : root)
    V.FS.writeFile(`${root}/${path}`, new Uint8Array(buf))
  }
  const model = new V.Model(root)
  // Kaldi has read them into its own structures: the copies can go.
  for (const path of files.keys()) V.FS.unlink(`${root}/${path}`)
  files.clear()
  const rec = new V.Recognizer(model, CAPTION_RATE)
  let cfg: WorkerConfig = cfg0
  rec.SetWords(cfg.minConfidence > 0)
  const ptr = V._malloc(CHUNK * 4)
  let held = 0

  const recogniser: Recogniser = {
    streaming: true,
    get held() {
      return held
    },
    accept(pcm) {
      let ended = false
      for (let at = 0; at < pcm.length; at += CHUNK) {
        const n = Math.min(CHUNK, pcm.length - at)
        // Kaldi wants 16-bit sample values; the heap view is fetched again each time (it moves when memory grows).
        const heap = V.HEAPF32
        const off = ptr >> 2
        for (let i = 0; i < n; i++) heap[off + i] = pcm[at + i] * 32768
        held += n
        if (rec.AcceptWaveform(ptr, n)) ended = true
      }
      return ended
    },
    result() {
      held = 0
      return words(rec.Result(), cfg.minConfidence)
    },
    partial() {
      try {
        return (JSON.parse(rec.PartialResult()) as { partial?: string }).partial ?? ''
      } catch {
        return ''
      }
    },
    finish() {
      held = 0
      return words(rec.FinalResult(), cfg.minConfidence)
    },
    configure(next) {
      if ((next.minConfidence > 0) !== (cfg.minConfidence > 0)) rec.SetWords(next.minConfidence > 0)
      cfg = next
    }
  }
  return recogniser
})
