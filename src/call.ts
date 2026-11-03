import { reactive, watch } from 'vue'
import { sameActivity } from './audio/activity'
import { AudioEngine, describeHeard, type MicProblem, type SpatialMode } from './audio/engine'
import { LOOP_ID, SEND_DELAY_MS, sanitizeLL, type LLConfig } from './audio/ll/config'
import { LowLatencyEngine } from './audio/ll/engine'
import { Captioner } from './captions/captioner'
import type { CaptionPrefs } from './captions/config'
import { encodeCaption } from './captions/protocol'
import {
  captionRun,
  captions,
  clearCaptions,
  forgetCaptions,
  forgetModelStatus,
  holdDownload,
  acceptDownload,
  modelStatus,
  ownCaption,
  receiveCaption,
  resetDownloadAnswer,
  setLinger
} from './captions/state'
import { copyText } from './lib/copyText'
import { loadPrefs, savePrefs, type Prefs } from './lib/prefs'
import { Seating } from './lib/seating'
import { createWakeLock } from './lib/wakeLock'
import { NativeBridge, isNative, native } from './native/bridge'
import { onMobileDevice } from './native/downloads'
import { NativeLinks } from './native/link'
import { driveOverlay } from './native/overlay'
import type { AppConfig } from './native/protocol'
import { NativeVoice } from './native/voice'
import { fetchIceServers, publicUrl } from './net/config'
import type { Member } from './net/protocol'
import { Session, type SessionFailure, type SessionStatus } from './net/session'
import { routeOf, type LinkStats } from './net/stats'

/**
 * The one call this tab can be in, as reactive state for the UI, plus
 * everything the UI can do to it.
 *
 * Two ways to do the audio. In a browser, the page does it all (AudioEngine,
 * the low-latency engine, the peer connections). In the app (native/), the
 * page is only the UI and the app does the audio: NativeVoice stands in for
 * the engines and NativeLinks for the peer connections, and the session
 * above them is the same either way.
 */

export type Phase = 'home' | 'joining' | 'room'

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error' | 'success'
}

export const call = reactive({
  phase: 'home' as Phase,
  /** What `joining` is doing, for the spinner on the right button. */
  joining: null as 'create' | 'join' | null,
  status: 'connecting' as SessionStatus,
  /** Shown on the start screen after a failed join or a lost call. */
  error: '',
  code: '',
  selfId: '',
  members: [] as Member[],
  speaking: new Set<string>(),
  /** Anyone making a sound at all (a thin ring), speaking or not. */
  audible: new Set<string>(),
  /** Your choice. What you send is muted if this, deafened, or there's no mic. */
  muted: false,
  deafened: false,
  micProblem: null as MicProblem,
  prefs: loadPrefs(),
  /** Per-person volume for you only, 0–1. */
  volumes: {} as Record<string, number>,
  /** People you've muted for yourself. */
  silenced: {} as Record<string, boolean>,
  /** Ping and route to each person, refreshed every second. */
  links: {} as Record<string, LinkStats>,
  toasts: [] as Toast[],
  /** The mic test: your own voice played back to you through one of the paths, with its latency. */
  test: {
    on: false,
    path: 'raw' as TestPath,
    /** Mic to speakers, ms. */
    ms: null as number | null,
    /** Measured from capture stamps, or only what the browser reports for its buffers. */
    measured: false,
    detail: ''
  }
})

export type TestPath = 'raw' | 'll'

let engine: AudioEngine | null = null
let ll: LowLatencyEngine | null = null
let session: Session | null = null

// ---- the app ---------------------------------------------------------------------

let bridge: NativeBridge | null = null
let nativeLinks: NativeLinks | null = null
/** The audio, when the app is doing it. */
let nv: NativeVoice | null = null

/**
 * Where everyone sits, for the audio and for every view of the table. It
 * lives here, with the audio it feeds, so the angles are right whether or
 * not anything is on screen (see lib/seating).
 */
export const seating = new Seating((id, angle) => {
  engine?.setAngle(id, angle)
  nv?.setAngle(id, angle)
})

// Whoever's in the call sits at the table; the seats move themselves from there.
watch(
  () => [call.selfId, ...call.members.map(m => m.id)].join(','),
  () => {
    if (!call.selfId || !call.members.length) return
    const ids = call.members.map(m => m.id)
    if (!ids.includes(call.selfId)) ids.unshift(call.selfId)
    seating.sync(ids, call.selfId)
  }
)

// The screen stays awake while you're in a room, if you let it. Says nothing either way.
const wakeLock = createWakeLock()
watch(
  () => call.phase === 'room' && call.prefs.keepAwake,
  on => wakeLock.set(on),
  { immediate: true }
)

/** In the app: connected to it, and on versions that work together. */
export const nativeReady: Promise<boolean> = isNative ? connectApp() : Promise.resolve(false)

function connectApp(): Promise<boolean> {
  const b = new NativeBridge(__APP_VERSION__, __NATIVE_VERSION__)
  bridge = b
  nativeLinks = new NativeLinks(b)
  return b.connect().then(ok => {
    if (ok) driveOverlay(b, call, seating)
    return ok
  })
}

export function getNative(): NativeVoice | null {
  return nv
}

/** Your settings, as the app needs them. */
function appConfig(): AppConfig {
  const p = call.prefs
  return {
    ll: { ...p.ll },
    spatial: p.spatial,
    inputId: p.appInputId,
    outputId: p.appOutputId,
    exclusive: p.appExclusive,
    bufferAuto: p.appBufferAuto,
    bufferMs: p.appBufferMs,
    processing: {
      echo: p.echoCancellation,
      noise: p.noiseSuppression,
      gain: p.autoGainControl,
      gateThreshold: p.noiseGate,
      gateGraceMs: p.noiseGraceMs,
      noiseLookahead: p.noiseLookahead,
      gainTargetDb: p.agcTargetDb,
      gainMaxDb: p.agcMaxDb,
      gainCeilingDb: p.agcCeilingDb,
      gainRiseMs: p.agcRiseMs,
      gainFallMs: p.agcFallMs
    },
    captions: native.app?.captions?.length ? appCaptions(p.captions) : undefined
  }
}

function appCaptions(c: CaptionPrefs): AppConfig['captions'] {
  return {
    send: c.send,
    model: c.model,
    showOwn: c.showOwn,
    preMs: c.preRollMs,
    postMs: c.postRollMs,
    partials: c.partials,
    partialsPerSec: c.partialsPerSec,
    rereadMs: c.rereadMs,
    maxPhraseSec: c.maxPhraseSec,
    minConfidence: c.minConfidence,
    threads: c.threads
  }
}
let speakingTimer: ReturnType<typeof setInterval> | null = null
let statsTimer: ReturnType<typeof setInterval> | null = null
let toastSeq = 0

export function getEngine(): AudioEngine | null {
  return engine
}

export function toast(text: string, kind: Toast['kind'] = 'info', ms = 4000) {
  const t = { id: ++toastSeq, text, kind }
  call.toasts.push(t)
  setTimeout(() => dismissToast(t.id), ms)
}

export function dismissToast(id: number) {
  const i = call.toasts.findIndex(t => t.id === id)
  if (i >= 0) call.toasts.splice(i, 1)
}

const FAILURES: Record<SessionFailure, string> = {
  'not-found': "There's no room with that code. Check it and try again.",
  full: 'That room is full.',
  unreachable: "Couldn't reach the room. Check your connection and try again.",
  unsupported: "This browser can't make voice calls.",
  version: 'That room is on a newer version of Pivoice. Reload the page to update.',
  busy: "Couldn't find a free room code. Try again."
}

export function updatePrefs(patch: Partial<Prefs>) {
  Object.assign(call.prefs, patch)
  savePrefs(call.prefs)
}

function effectiveMuted(): boolean {
  return call.muted || call.deafened || !!call.micProblem
}

function pushSelfState() {
  nv?.setSelf(effectiveMuted(), call.deafened)
  engine?.setMicEnabled(!effectiveMuted())
  engine?.setDeafened(call.deafened)
  session?.setSelf({ muted: effectiveMuted(), deafened: call.deafened })
  updateLLActive()
}

/** The low-latency engine only encodes while someone's listening on it and you're not muted. */
function updateLLActive() {
  updateCaptionListening()
  if (!ll) return
  ll.setGate(
    effectiveMuted(),
    call.members.filter(m => m.deafened).map(m => m.id)
  )
  ll.setActive(!!session && !effectiveMuted() && session.llListeners() > 0)
}

/**
 * Make or join a room. Must be called straight from a click: the audio
 * context is created before the first await so the browser lets it play.
 */
export async function startCall(kind: 'create' | 'join', name: string, code = '') {
  if (call.phase !== 'home') return
  updatePrefs({ name })
  call.phase = 'joining'
  call.joining = kind
  call.error = ''
  call.members = []
  call.speaking = new Set()
  call.audible = new Set()
  call.volumes = {}
  call.silenced = {}
  call.links = {}
  resetDownloadAnswer()
  await connect(kind, name, code)
}

/** Set while we drop and come straight back (rejoinCall): the room stays on screen. */
let rejoining = false

/**
 * Drop the call and come straight back into the same room as the same
 * person, for settings that can only apply to a fresh connection (the
 * audio output buffer, what we ask senders for in SDP). Everyone else
 * sees us reconnecting for a moment; our seat, mute state and the volumes
 * we've set for people all carry over.
 */
export async function rejoinCall() {
  const s = session
  if (!s || call.phase !== 'room' || rejoining) return
  const code = s.code
  const joinedAt = s.joinedAt
  rejoining = true
  call.status = 'reconnecting'
  s.drop()
  await connect('join', call.prefs.name, code, joinedAt === null ? undefined : { key: s.key, joinedAt })
}

async function connect(kind: 'create' | 'join', name: string, code: string, rejoin?: { key: string; joinedAt: number }) {
  call.links = {}
  if (isNative) return connectNative(kind, name, code, rejoin)

  const eng = new AudioEngine(call.prefs.outputBuffer)
  engine = eng
  // A new engine hasn't been told where anyone sits (coming back after a rejoin, say).
  seating.flush()
  const icePromise = fetchIceServers()
  await eng.openMic(micSettings())
  if (engine !== eng) return
  call.micProblem = eng.micProblem
  if (rejoin) {
    // Coming back: already told them.
  } else if (eng.micProblem === 'denied') toast("Microphone blocked. You can listen, but nobody can hear you.", 'error', 7000)
  else if (eng.micProblem) toast("Couldn't open a microphone. You can listen, but nobody can hear you.", 'error', 7000)
  eng.setSpatial(call.prefs.spatial)
  if (call.prefs.outputId) void eng.setOutputDevice(call.prefs.outputId)
  eng.setMicEnabled(!effectiveMuted())
  eng.setDeafened(call.deafened)
  // The low-latency engine is how everyone hears everyone: no engine, no call.
  if (!LowLatencyEngine.supported() || eng.ctx.sampleRate !== 48_000) {
    rejoining = false
    cleanup()
    call.error = FAILURES.unsupported
    return
  }
  const engLL = new LowLatencyEngine(eng.ctx, call.prefs.ll, {
    link: (id, up) => session?.llState(id, up),
    relay: (to, buf) => session?.sendLL(to, buf)
  })
  engLL.inputLatencyMs = () => eng.captureLatencyMs() ?? 0
  engLL.setMic(eng.micSource)
  eng.onMic = src => {
    engLL.setMic(src)
    void plugCaptions()
  }
  ll = engLL

  const iceServers = await icePromise
  if (engine !== eng) return
  const s = new Session(
    {
      name,
      muted: effectiveMuted(),
      deafened: call.deafened,
      iceServers,
      rejoin
    },
    {
      status: (status, failure) => {
        if (session !== s) return
        onStatus(status, failure)
      },
      roster: members => {
        if (session !== s) return
        call.selfId = s.selfId
        call.members = members
        forgetLeavers()
        updateLLActive()
      },
      llLink: (id, up) => {
        if (session !== s || !ll) return
        const engLL = ll
        if (up) {
          void engLL.addRemote(id).then(node => {
            if (session !== s || !node || !s.isLL(id)) return
            eng.attachLL(id, node)
            if (call.volumes[id] !== undefined) eng.setVolume(id, call.volumes[id])
            if (call.silenced[id]) eng.setSilenced(id, true)
          })
        } else {
          eng.detachLL(id)
          engLL.removeRemote(id)
        }
        updateLLActive()
      },
      llPacket: (id, data) => {
        if (session === s) ll?.packet(id, data)
      },
      caption: (id, data) => {
        if (session === s) receiveCaption(id, data)
      }
    }
  )
  session = s
  s.adoptLL = (id, ch) => engLL.adoptChannel(id, ch)
  if (kind === 'create') await s.create()
  else await s.join(code)
}

/** The app does the audio and makes the connections; the page runs the call. */
async function connectNative(kind: 'create' | 'join', name: string, code: string, rejoin?: { key: string; joinedAt: number }) {
  if (!(await nativeReady) || !bridge || !nativeLinks) {
    // The app screen says what's wrong (see NativeGate).
    rejoining = false
    cleanup()
    return
  }
  const v = new NativeVoice(bridge)
  nv = v
  v.onCaptions = st => {
    if (nv !== v) return
    modelStatus({ phase: st.phase === 'off' ? 'checking' : st.phase, bytes: st.bytes, total: st.total, error: st.error }, st.model, call.prefs.captions, false, () =>
      v.captions('download')
    )
    if (st.phase === 'off') captions.model.phase = 'off'
    captions.rtf = st.rtf ?? null
    captions.listening = !!st.listening
    captions.hearing = {
      kind: 'app',
      detail: st.hears === 'echo' ? 'echo cancellation on, noise suppression off, auto gain off' : 'echo cancellation off, noise suppression off, auto gain off',
      note: st.hears === 'echo' ? 'the mic after the app’s echo canceller, before its noise suppression and gain' : 'the mic as the sound card gives it'
    }
  }
  v.onCaption = (peer, m) => {
    if (nv !== v) return
    if (peer) receiveCaption(peer, m.data)
    else if (m.u !== undefined && m.text !== undefined) ownCaption(call.selfId, m.u, m.text, !!m.final, call.prefs.captions)
  }
  seating.flush()
  const icePromise = fetchIceServers()
  await v.start(appConfig())
  if (nv !== v) return
  call.micProblem = v.micProblem
  if (!rejoin && v.micProblem) toast("Couldn't open a microphone. You can listen, but nobody can hear you.", 'error', 7000)
  v.setSelf(effectiveMuted(), call.deafened)
  for (const [id, volume] of Object.entries(call.volumes)) v.setVolume(id, volume)
  for (const [id, on] of Object.entries(call.silenced)) if (on) v.setSilenced(id, true)

  const iceServers = await icePromise
  if (nv !== v) return
  const s = new Session(
    {
      name,
      muted: effectiveMuted(),
      deafened: call.deafened,
      iceServers,
      rejoin,
      links: nativeLinks
    },
    {
      status: (status, failure) => {
        if (session === s) onStatus(status, failure)
      },
      roster: members => {
        if (session !== s) return
        call.selfId = s.selfId
        call.members = members
        forgetLeavers()
        v.setMembers(members)
      },
      // The app plays everyone itself.
      llLink: () => {},
      llPacket: () => {}
    }
  )
  session = s
  if (kind === 'create') await s.create()
  else await s.join(code)
}

function onStatus(status: SessionStatus, failure?: SessionFailure) {
  const wasInRoom = call.phase === 'room'
  call.status = status
  if (status === 'connected') {
    if (session) {
      call.code = session.code
      call.selfId = session.selfId
    }
    rejoining = false
    if (engine && !captioner) void startCaptions()
    if (!speakingTimer) startSpeakingPoll()
    if (!statsTimer) startStatsPoll()
    if (call.phase !== 'room') {
      call.phase = 'room'
      call.joining = null
      // The code stays out of the address bar, like everywhere else it's hidden by default.
      if (location.hash) history.replaceState(null, '', location.pathname + location.search)
    }
  } else if (status === 'failed') {
    rejoining = false
    cleanup()
    call.error = wasInRoom ? 'Lost the connection to the room.' : FAILURES[failure ?? 'unreachable']
  } else if (status === 'ended') {
    cleanup()
  } else if (rejoining) {
    // Still putting ourselves back together: say so in the header.
    call.status = 'reconnecting'
  }
}

function cleanup() {
  stopMicTest()
  stopCaptions()
  clearCaptions()
  session = null
  nv?.close()
  nv = null
  ll?.close()
  ll = null
  engine?.close()
  engine = null
  if (speakingTimer) clearInterval(speakingTimer)
  speakingTimer = null
  if (statsTimer) clearInterval(statsTimer)
  statsTimer = null
  call.links = {}
  // Coming straight back: keep the room on screen, everyone at the table.
  if (rejoining) return
  seating.reset()
  call.phase = 'home'
  call.joining = null
  call.members = []
  call.speaking = new Set()
  call.audible = new Set()
}

export function leaveCall() {
  const s = session
  if (s) s.leave()
  else cleanup()
}

export function toggleShowCode() {
  updatePrefs({ showCode: !call.prefs.showCode })
}

function startSpeakingPoll() {
  if (speakingTimer) clearInterval(speakingTimer)
  speakingTimer = setInterval(() => {
    const src = nv ?? engine
    if (!src) return
    const now = src.activity(call.selfId)
    if (sameActivity(now, { speaking: call.speaking, audible: call.audible })) return
    call.speaking = now.speaking
    call.audible = now.audible
  }, 50)
}

function startStatsPoll() {
  if (statsTimer) clearInterval(statsTimer)
  let busy = false
  const poll = async () => {
    const s = session
    if (!s || busy) return
    busy = true
    try {
      if (nv) {
        // The app measures its own links, the way the route card wants them.
        const st = await nv.stats()
        if (session === s && st) call.links = st.peers
        return
      }
      ll?.refresh()
      // getStats() stalls Chrome's network thread, which is where the
      // engine's packets come in, and its jitter buffer grows to cover the
      // hiccup. So ping comes from the engine's own pings, and the
      // connection's stats (the route) are only read for the route card.
      const llReports = call.prefs.showRoute ? await s.getLLStats() : new Map<string, RTCStatsReport>()
      if (session !== s) return
      const next: Record<string, LinkStats> = {}
      const captureMs = engine?.captureLatencyMs() ?? null
      const outMs = engine ? (engine.ctx.baseLatency + (engine.ctx.outputLatency || 0)) * 1000 : null
      for (const m of call.members) {
        const id = m.id
        const llStats = s.isLL(id) ? ll?.stats(id) : null
        if (!llStats) continue
        const route = routeOf((llReports.get(id)?.values() ?? []) as Iterable<Record<string, unknown>>)
        const rttMs = route.rttMs ?? llStats.rttMs
        next[id] = {
          ...route,
          rttMs,
          bufferMs: llStats.bufferMs,
          jitterMs: llStats.jitterMs,
          lossPct: llStats.concealedPct,
          kbps: llStats.kbps,
          playoutMs: outMs,
          captureMs,
          sendMs: SEND_DELAY_MS,
          mouthToEarMs:
            rttMs !== null && llStats.bufferMs !== null ? (captureMs ?? 0) + SEND_DELAY_MS + rttMs / 2 + llStats.bufferMs + (outMs ?? 0) : null,
          measuredMs: llStats.measuredMs,
          ll: llStats
        }
      }
      call.links = next
    } finally {
      busy = false
    }
  }
  void poll()
  statsTimer = setInterval(poll, 1000)
}

/** Web Audio's output buffer is fixed when the audio context is made, so changing it reconnects you. */
export function setOutputBuffer(v: Prefs['outputBuffer']) {
  if (v === call.prefs.outputBuffer) return
  updatePrefs({ outputBuffer: v })
  const path = call.test.on ? call.test.path : null
  stopMicTest()
  void rejoinCall().then(() => {
    // Carry on testing with the new buffer, so the difference is easy to hear.
    if (path) void startMicTest(path)
  })
}

// ---- live captions ----------------------------------------------------------

/**
 * Each of us captions ourselves, on our own machine, and sends the words
 * to everyone (captions/). In a browser that's the Captioner here (a
 * worklet and a worker beside the call's audio); in the app, the app
 * itself (natively, see native/internal/asr), which the page only
 * configures and shows.
 */
let captioner: Captioner | null = null
setLinger(call.prefs.captions.lingerSec)

/** Where the site keeps the models (scripts/captions-models.mjs puts them there). */
function captionBase(): string {
  return new URL('captions/', document.baseURI).href
}

/** Browser: the recogniser for this call, if you're captioned at all. */
async function startCaptions() {
  stopCaptions()
  const eng = engine
  const p = call.prefs.captions
  if (!eng || !p.send) return
  const c: Captioner = new Captioner(eng.ctx, p, captionBase(), {
    status: st => {
      if (captioner !== c) return
      modelStatus(st, c.model, call.prefs.captions, onMobileDevice(), () => c.download())
      updateCaptionListening()
    },
    text: (u, text, final) => {
      if (captioner !== c) return
      ownCaption(call.selfId, u, text, final, call.prefs.captions)
      session?.sendCaption(encodeCaption({ s: captionRun(), u, t: text, f: final }))
    },
    stats: (rtf, lost) => {
      if (captioner !== c) return
      captions.rtf = rtf
      captions.lost = lost
    }
  })
  captioner = c
  await plugCaptions()
}

/** The mic changed (or captions just started): what the recogniser hears, raw if it can be. */
async function plugCaptions() {
  const c = captioner
  const eng = engine
  if (!c || !eng) return
  const src = await eng.captionSources(call.prefs.captions.source)
  if (captioner !== c) return
  c.setSources(src?.raw ?? null, src?.ring ?? null)
  captions.hearing = src ? { kind: src.kind, detail: describeHeard(src.heard), note: src.note } : { kind: '', detail: '', note: 'no microphone' }
}

function stopCaptions() {
  captioner?.close()
  captioner = null
  forgetModelStatus()
  engine?.closeRawMic()
  captions.listening = false
  captions.hearing = { kind: '', detail: '', note: '' }
  captions.model = { phase: 'off', bytes: 0, total: 0, error: '' }
}

/** Listening for your ring: unmuted, someone to send to (or you want to see your own), and the model's ready. */
function updateCaptionListening() {
  if (!captioner) return
  const p = call.prefs.captions
  const on = !!session && p.send && !effectiveMuted() && (session.connectedCount() > 0 || p.showOwn) && captions.model.phase === 'ready'
  captioner.setListening(on)
  captions.listening = on
}

function forgetLeavers() {
  const here = new Set(call.members.map(m => m.id))
  for (const id of Object.keys(captions.views)) if (!here.has(id) && id !== call.selfId) forgetCaptions(id)
}

/** Change caption settings; all of them apply live (another model or source starts the recogniser again). */
export function updateCaptions(patch: Partial<CaptionPrefs>) {
  const before = call.prefs.captions
  const next = { ...before, ...patch }
  updatePrefs({ captions: next })
  setLinger(next.lingerSec)
  if (nv) {
    nv.configure(appConfig())
    return
  }
  if (call.phase !== 'room' || !engine) return
  if (next.send !== before.send || next.model !== before.model) void startCaptions()
  else {
    captioner?.configure(next)
    if (next.source !== before.source) void plugCaptions()
    updateCaptionListening()
  }
}

/** The settings' "download now", when it was declined, held or is still waiting to be asked. */
export function downloadCaptionModel() {
  acceptDownload()
  if (nv) nv.captions('download')
  else captioner?.download()
}

/**
 * The settings' "remove": the downloaded model goes (in the app, its cache
 * folder's copy; a browser's is removed by the settings themselves), and
 * isn't fetched again by itself this call.
 */
export function forgetCaptionModel() {
  holdDownload()
  nv?.captions('forget')
}

// ---- mic test ----------------------------------------------------------------

let testTimer: ReturnType<typeof setInterval> | null = null
/** Whether we deafened you for the test (and so undeafen you after). */
let testDeafened = false

/**
 * Hear yourself, like Discord's mic test, through one path with no
 * network: raw (mic straight to the speakers: your device and the
 * browser's buffers, the floor everything else sits on), or as in a call
 * (the low-latency engine's gate, packets and jitter buffer). You're
 * deafened while it runs, so you only hear yourself.
 */
export async function startMicTest(path: TestPath) {
  if (nv) return startNativeMicTest(path)
  const eng = engine
  if (!eng || call.phase !== 'room') return
  stopMicTest()
  Object.assign(call.test, { on: true, path, ms: null, measured: false, detail: '' })
  if (!call.deafened) {
    testDeafened = true
    call.deafened = true
    pushSelfState()
  }
  if (path === 'raw') {
    eng.setRawLoopback(true)
  } else if (ll) {
    await ll.startLoop(eng.testOut)
  }
  if (!call.test.on || engine !== eng) return
  const tick = async () => {
    const t = call.test
    const out = (eng.ctx.baseLatency + (eng.ctx.outputLatency || 0)) * 1000
    if (t.path === 'raw') {
      t.ms = eng.rawLoopbackMs()
      t.measured = false
      t.detail = `mic ${Math.round(eng.captureLatencyMs() ?? 0)} + output ${Math.round(out)} ms, as the browser reports them`
    } else if (t.path === 'll' && ll) {
      ll.refresh()
      const s = ll.stats(LOOP_ID)
      t.ms = s?.measuredMs ?? null
      t.measured = t.ms !== null
      t.detail = s
        ? `buffer ${Math.round(s.bufferMs ?? 0)} ms (target ${Math.round(s.targetMs)}) · concealed ${s.concealedPct.toFixed(1)}% · late ${s.late}`
        : ''
    }
  }
  void tick()
  testTimer = setInterval(() => void tick(), 1000)
}

/**
 * In the app: raw is the mic straight to the speakers inside the sound
 * card's own callback (like pw-loopback), and as in a call is the app's
 * whole engine looped back.
 */
function startNativeMicTest(path: TestPath) {
  const v = nv
  if (!v || call.phase !== 'room') return
  stopMicTest()
  Object.assign(call.test, { on: true, path, ms: null, measured: false, detail: '' })
  if (!call.deafened) {
    testDeafened = true
    call.deafened = true
    pushSelfState()
  }
  v.test(path)
  const tick = async () => {
    const st = await v.stats()
    if (!call.test.on || nv !== v || !st?.test) return
    Object.assign(call.test, { ms: st.test.ms, measured: st.test.measured, detail: st.test.detail })
  }
  void tick()
  testTimer = setInterval(() => void tick(), 1000)
}

export function stopMicTest() {
  if (testTimer) clearInterval(testTimer)
  testTimer = null
  nv?.test('')
  engine?.setRawLoopback(false)
  ll?.stopLoop()
  if (call.test.on && testDeafened) {
    call.deafened = false
    pushSelfState()
  }
  testDeafened = false
  call.test.on = false
}

/** Change low-latency engine settings; everything applies live. */
export function updateLL(patch: Partial<LLConfig>) {
  const next = sanitizeLL({ ...call.prefs.ll, ...patch })
  updatePrefs({ ll: next })
  ll?.configure(next)
  nv?.configure(appConfig())
  updateLLActive()
}

export function toggleMute() {
  if (call.micProblem) {
    toast(call.micProblem === 'denied' ? 'Allow the microphone in your browser, then rejoin.' : 'No microphone to unmute.', 'error')
    return
  }
  // Like Discord: unmuting while deafened undeafens too.
  if (call.deafened) {
    call.deafened = false
    call.muted = false
  } else call.muted = !call.muted
  pushSelfState()
}

export function toggleDeafen() {
  // Your call now: the mic test won't undeafen you when it stops.
  testDeafened = false
  call.deafened = !call.deafened
  pushSelfState()
}

export function setSpatial(mode: SpatialMode) {
  updatePrefs(mode === 'off' ? { spatial: mode } : { spatial: mode, lastSpatial: mode })
  engine?.setSpatial(mode)
  nv?.configure(appConfig())
}

export function toggleSpatial() {
  setSpatial(call.prefs.spatial === 'off' ? call.prefs.lastSpatial : 'off')
}

function micSettings() {
  const p = call.prefs
  return {
    deviceId: p.inputId,
    echoCancellation: p.echoCancellation,
    noiseSuppression: p.noiseSuppression,
    autoGainControl: p.autoGainControl
  }
}

/** Reopen the microphone with new settings (the engine follows it, see eng.onMic). */
export async function applyMicPrefs(patch: Partial<Pick<Prefs, 'inputId' | 'echoCancellation' | 'noiseSuppression' | 'autoGainControl'>>) {
  updatePrefs(patch)
  nv?.configure(appConfig())
  const eng = engine
  if (!eng) return
  await eng.openMic(micSettings())
  if (engine !== eng) return
  call.micProblem = eng.micProblem
  pushSelfState()
}

export async function setOutput(deviceId: string) {
  updatePrefs({ outputId: deviceId })
  await engine?.setOutputDevice(deviceId)
}

/** In the app: its own devices and how it opens them (it reopens the sound card on the spot), and its processing. */
export function setAppDevices(
  patch: Partial<
    Pick<
      Prefs,
      | 'appInputId'
      | 'appOutputId'
      | 'appExclusive'
      | 'appBufferAuto'
      | 'appBufferMs'
      | 'noiseGate'
      | 'noiseGraceMs'
      | 'noiseLookahead'
      | 'agcTargetDb'
      | 'agcMaxDb'
      | 'agcCeilingDb'
      | 'agcRiseMs'
      | 'agcFallMs'
    >
  >
) {
  updatePrefs(patch)
  nv?.configure(appConfig())
}

export function setVolume(id: string, volume: number) {
  call.volumes[id] = volume
  engine?.setVolume(id, volume)
  nv?.setVolume(id, volume)
}

export function setSilenced(id: string, on: boolean) {
  call.silenced[id] = on
  engine?.setSilenced(id, on)
  nv?.setSilenced(id, on)
}

/** Your microphone level, 0–1, for the meters. */
export function micLevel(): number {
  return (nv ?? engine)?.micLevel() ?? 0
}

export function inviteLink(): string {
  return publicUrl() + '#' + call.code
}

export async function copyInvite() {
  if (await copyText(inviteLink())) toast('Invite link copied', 'success', 2500)
  else toast("Couldn't copy the invite link.", 'error')
}

export async function copyCode() {
  if (await copyText(call.code)) toast('Room code copied', 'success', 2500)
}

window.addEventListener('pagehide', () => session?.leave())

// Dev builds only: a handle for poking at a live call from the console or the e2e run.
if (import.meta.env.DEV) {
  ;(window as unknown as { __pv: unknown }).__pv = { call, session: () => session, ll: () => ll, engine: () => engine, native: () => nv, rejoin: rejoinCall }
}
