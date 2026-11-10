import { reactive } from 'vue'
import { CaptionBoard, type CaptionView } from './board'
import { CaptionConversation } from './conversation'
import { decodeCaption } from './protocol'
import type { CaptionPrefs } from './config'
import type { ModelId } from './models'
import { currentConnection, downloadDecision, metered, type Metered } from './network'
import type { ModelPhase, ModelStatus } from './worker-core'

/**
 * Captions as the UI sees them, wherever they come from: everyone's (the
 * captions channel, checked and rate-limited in the board), yours (your
 * recogniser, in this tab or in the app), how the model's getting on, and
 * whether we're asking before a download.
 */

export const captions = reactive({
  /** Who's saying what, for the seats and tiles. */
  views: {} as Record<string, CaptionView>,
  model: { phase: 'off' as ModelPhase | 'off', bytes: 0, total: 0, error: '' },
  /**
   * Asking first: the model is this big; `network` when it's the connection
   * that made us ask (mobile data, or a phone that won't say), not the
   * settings' "Always ask".
   */
  prompt: null as { model: ModelId; bytes: number; metered: Metered; network: boolean } | null,
  /** Seconds of work per second of speech, lately (under 1 keeps up). */
  rtf: null as number | null,
  /** Speech lost because the recogniser fell too far behind (samples, 48 kHz). */
  lost: 0,
  /**
   * What the recogniser hears, for the settings to show (debugging): in a
   * browser, which capture and what the browser says it has on
   * (AudioEngine.captionSources); in the app, raw or after echo cancellation.
   */
  hearing: { kind: '' as '' | 'own' | 'call' | 'app', detail: '', note: '' },
  /** Your ring's being listened for (you're unmuted, there's someone to send to, the model's ready). */
  listening: false
})

const board = new CaptionBoard()
export const conversation = reactive(new CaptionConversation())
let linger = 6000
let sweep: ReturnType<typeof setInterval> | null = null
/**
 * This run of your captions (so a rejoin, counting from 0 again, isn't taken
 * for old news). A recogniser starting again also counts from 0: it needs a
 * new run too, or the board would take its first phrases for ones it has
 * already seen and drop them.
 */
let run = Math.floor(Math.random() * 0x7fffffff)

/** Another recogniser is starting: its phrase numbers start over. */
export function newCaptionRun() {
  run = (run + 1) % 0x80000000
}

function show(id: string) {
  const v = board.view(id)
  if (v) captions.views[id] = v
  else delete captions.views[id]
  if (!sweep && Object.keys(captions.views).length) {
    sweep = setInterval(() => {
      for (const gone of board.expire(performance.now(), linger)) delete captions.views[gone]
      if (!Object.keys(captions.views).length && sweep) {
        clearInterval(sweep)
        sweep = null
      }
    }, 250)
  }
}

/** Someone's message off the captions channel (anything at all: it's checked). */
export function receiveCaption(id: string, data: unknown) {
  const now = performance.now()
  if (board.receive(id, data, now)) {
    show(id)
    const m = decodeCaption(data)
    if (m) conversation.apply(id, m, now)
  }
}

/** Your own words, to show beside you (if you want them shown). */
export function ownCaption(selfId: string, u: number, text: string, final: boolean, prefs: CaptionPrefs) {
  if (!prefs.showOwn || !selfId) return
  const m = { s: run, u, t: text, f: final }
  const now = performance.now()
  if (board.apply(selfId, m, now)) {
    show(selfId)
    conversation.apply(selfId, m, now)
  }
}

/** The run number your captions go out under. */
export function captionRun(): number {
  return run
}

export function forgetCaptions(id: string) {
  board.forget(id)
  delete captions.views[id]
}

export function clearCaptions() {
  board.clear()
  for (const id of Object.keys(captions.views)) delete captions.views[id]
  captions.prompt = null
  captions.listening = false
  captions.rtf = null
  captions.lost = 0
  captions.model = { phase: 'off', bytes: 0, total: 0, error: '' }
  captions.hearing = { kind: '', detail: '', note: '' }
}

export function setLinger(sec: number) {
  linger = sec * 1000
}

// ---- the model: downloading when the network allows, asking otherwise ----------

let download: (() => void) | null = null
let declined = false
/** The downloaded copy was just removed: don't fetch it again by ourselves until asked (or the next call). */
let held = false
let watching: { conn: EventTarget; fn: () => void } | null = null

function unwatch() {
  if (watching) watching.conn.removeEventListener('change', watching.fn)
  watching = null
}

/**
 * How the model's getting on. When it needs downloading, the policy and
 * the connection decide: go ahead, or ask (and go ahead by ourselves if
 * the connection changes to one that doesn't cost, Wi-Fi say).
 */
export function modelStatus(s: ModelStatus, model: ModelId, prefs: CaptionPrefs, phone: boolean, go: () => void) {
  captions.model = { phase: s.phase, bytes: s.bytes, total: s.total, error: s.error ?? '' }
  if (s.phase !== 'needed') {
    if (s.phase !== 'checking') captions.prompt = null
    download = null
    unwatch()
    return
  }
  download = go
  const decide = () => {
    const m = metered(currentConnection())
    if (held) return
    if (downloadDecision(prefs.download, m, phone) === 'download') {
      captions.prompt = null
      unwatch()
      download?.()
      download = null
    } else if (!declined) captions.prompt = { model, bytes: s.total, metered: m, network: downloadDecision('wifi', m, phone) === 'ask' }
  }
  decide()
  const conn = currentConnection()
  if (captions.prompt && conn && !watching) {
    watching = { conn, fn: decide }
    conn.addEventListener('change', decide)
  }
}

/** The person said yes (the prompt, or the settings' "Download now"). */
export function acceptDownload() {
  declined = false
  held = false
  captions.prompt = null
  unwatch()
  download?.()
  download = null
}

/** Not now: for this call (the settings can still start it). */
export function declineDownload() {
  declined = true
  captions.prompt = null
}

/** A new call asks again. */
export function resetDownloadAnswer() {
  declined = false
  held = false
}

/** The settings' "remove": no fetching it again by ourselves this call. */
export function holdDownload() {
  held = true
  captions.prompt = null
}

/** The recogniser stopped: whatever we were waiting to download for it is moot. */
export function forgetModelStatus() {
  captions.prompt = null
  download = null
  unwatch()
}
