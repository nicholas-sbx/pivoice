import workletUrl from './worklet.ts?worker&url'
import FastConformerWorker from './fastconformer.worker.ts?worker'
import ParakeetWorker from './parakeet.worker.ts?worker'
import VoskWorker from './vosk.worker.ts?worker'
import { FrameRing } from '../audio/ll/ring'
import { MAX_PRE_ROLL_MS, type CaptionPrefs } from './config'
import { modelOf, type ModelId } from './models'
import { CAPTION_FRAME, CAPTION_SLOTS, type CaptionTapMessage, type CaptionTapOptions } from './tap'
import type { FromCaptionWorker, ModelStatus, ToCaptionWorker, WorkerConfig } from './worker-core'

/**
 * Captions in a browser, main-thread half: it sets up the caption worklet
 * (the gate, on the audio thread) and the recogniser's worker, plugs the
 * mic into them and passes on what comes back. Nothing here is in the path
 * of the audio: the worklet is a node of its own beside the call's, and it
 * talks to the worker directly.
 *
 *   raw mic ─────┐
 *                ├─▶ pv-caption (gate) ──frames──▶ worker (Vosk, Parakeet or FastConformer) ──words──▶ here
 *   call's mic ──┘   (the ring's level)
 */

export interface CaptionerEvents {
  status(s: ModelStatus): void
  text(u: number, text: string, final: boolean): void
  stats(rtf: number | null, lost: number): void
}

export function workerConfig(p: CaptionPrefs): WorkerConfig {
  return { partials: p.partials, partialsPerSec: p.partialsPerSec, rereadMs: p.rereadMs, maxPhraseSec: p.maxPhraseSec, minConfidence: p.minConfidence }
}

export class Captioner {
  readonly model: ModelId
  private worker: Worker
  private node: AudioWorkletNode | null = null
  private sink: GainNode
  private ready: Promise<void>
  private raw: AudioNode | null = null
  private ring: AudioNode | null = null
  private listening = false
  private closed = false

  constructor(
    ctx: AudioContext,
    prefs: CaptionPrefs,
    /** Where the models are (the site's /captions/). */
    base: string,
    private events: CaptionerEvents
  ) {
    this.model = prefs.model
    const engine = modelOf(prefs.model)?.engine
    this.worker = engine === 'nemo-ctc' ? new ParakeetWorker() : engine === 'nemo-ctc-streaming' ? new FastConformerWorker() : new VoskWorker()
    this.worker.onmessage = (e: MessageEvent<FromCaptionWorker>) => this.onWorker(e.data)
    const shared = typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated
    const ring = shared ? FrameRing.create(CAPTION_SLOTS, CAPTION_FRAME) : null
    const pipe = ring ? null : new MessageChannel()
    this.post({ type: 'init', model: prefs.model, base, cfg: workerConfig(prefs), ring: ring?.sab, port: pipe?.port2 }, pipe ? [pipe.port2] : [])

    // The node has to be pulled to run: a silent gain to the speakers does that.
    this.sink = ctx.createGain()
    this.sink.gain.value = 0
    this.sink.connect(ctx.destination)
    this.ready = ctx.audioWorklet.addModule(workletUrl).then(() => {
      if (this.closed) return
      this.node = new AudioWorkletNode(ctx, 'pv-caption', {
        numberOfInputs: 2,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { preMs: prefs.preRollMs, postMs: prefs.postRollMs, maxPreMs: MAX_PRE_ROLL_MS, ring: ring?.sab } satisfies CaptionTapOptions
      })
      if (pipe) this.tap({ port: pipe.port1 }, [pipe.port1])
      this.node.connect(this.sink)
      this.plug()
      this.tap({ on: this.listening })
    })
  }

  private post(m: ToCaptionWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(m, transfer)
  }

  private tap(m: CaptionTapMessage, transfer: Transferable[] = []) {
    this.node?.port.postMessage(m, transfer)
  }

  private onWorker(m: FromCaptionWorker) {
    if (this.closed) return
    if (m.type === 'model') this.events.status(m.status)
    else if (m.type === 'text') this.events.text(m.u, m.text, m.final)
    else if (m.type === 'stats') this.events.stats(m.rtf, m.lost)
  }

  /** What it hears (raw), and what the ring goes by (the call's mic). */
  setSources(raw: AudioNode | null, ring: AudioNode | null) {
    this.unplug()
    this.raw = raw
    this.ring = ring
    this.plug()
  }

  private plug() {
    if (!this.node) return
    this.raw?.connect(this.node, 0, 0)
    this.ring?.connect(this.node, 0, 1)
  }

  private unplug() {
    if (!this.node) return
    for (const [src, input] of [
      [this.raw, 0],
      [this.ring, 1]
    ] as const) {
      try {
        src?.disconnect(this.node, 0, input)
      } catch {
        /* wasn't connected */
      }
    }
  }

  /** Whether you're being captioned (the gate still only opens while your ring's lit). */
  setListening(on: boolean) {
    if (on === this.listening) return
    this.listening = on
    void this.ready.then(() => this.tap({ on }))
  }

  /** Go ahead with the download it's waiting for. */
  download() {
    this.post({ type: 'download' })
  }

  configure(prefs: CaptionPrefs) {
    this.post({ type: 'config', cfg: workerConfig(prefs) })
    this.tap({ preMs: prefs.preRollMs, postMs: prefs.postRollMs })
  }

  close() {
    this.closed = true
    this.tap({ on: false })
    this.unplug()
    this.node?.disconnect()
    this.sink.disconnect()
    this.worker.terminate()
  }
}
