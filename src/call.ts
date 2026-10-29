import { reactive } from 'vue'
import { sameActivity } from './audio/activity'
import { AudioEngine, type MicProblem, type SpatialMode } from './audio/engine'
import { LOOP_ID, sanitizeLL, sendDelayMs, type LLConfig } from './audio/ll/config'
import { WebRTCLoopback } from './audio/loopback'
import { LowLatencyEngine } from './audio/ll/engine'
import { copyText } from './lib/copyText'
import { loadPrefs, savePrefs, type Prefs } from './lib/prefs'
import { NativeBridge, isNative } from './native/bridge'
import { NativeLinks } from './native/link'
import type { AppConfig } from './native/protocol'
import { NativeVoice } from './native/voice'
import { fetchIceServers, publicUrl } from './net/config'
import type { Member } from './net/protocol'
import { Session, type SessionFailure, type SessionStatus } from './net/session'
import { captureToSpeakerMs, summarise, type LinkStats, type Snapshot } from './net/stats'

/**
 * The one call this tab can be in, as reactive state for the UI, plus
 * everything the UI can do to it.
 *
 * Two ways to do the audio. In a browser, the page does it all (AudioEngine,
 * the low-latency engine, WebRTC). In the app (native/), the page is only
 * the UI and the app does the audio: NativeVoice stands in for the engines
 * and NativeLinks for the peer connections, and the session above them is
 * the same either way.
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

export type TestPath = 'raw' | 'webrtc' | 'll'

let engine: AudioEngine | null = null
let ll: LowLatencyEngine | null = null
/** Recent measured mouth-to-ear samples on the WebRTC path, per person. */
const measured = new Map<string, number[]>()

/** The app always has the low-latency engine. */
export const llSupported = isNative || LowLatencyEngine.supported()
let session: Session | null = null

// ---- the app ---------------------------------------------------------------------

let bridge: NativeBridge | null = null
let nativeLinks: NativeLinks | null = null
/** The audio, when the app is doing it. */
let nv: NativeVoice | null = null

/** In the app: connected to it, and on versions that work together. */
export const nativeReady: Promise<boolean> = isNative ? connectApp() : Promise.resolve(false)

function connectApp(): Promise<boolean> {
  const b = new NativeBridge(__APP_VERSION__, __NATIVE_VERSION__)
  bridge = b
  nativeLinks = new NativeLinks(b)
  return b.connect()
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
    dtx: p.dtx,
    inputId: p.appInputId,
    outputId: p.appOutputId,
    exclusive: p.appExclusive,
    processing: {
      echo: p.echoCancellation,
      noise: p.noiseSuppression,
      gain: p.autoGainControl,
      gateThreshold: p.noiseGate,
      gateGraceMs: p.noiseGraceMs,
      noiseLookahead: p.noiseLookahead,
      gainTargetDb: p.agcTargetDb,
      gainMaxDb: p.agcMaxDb
    }
  }
}
let speakingTimer: ReturnType<typeof setInterval> | null = null
let statsTimer: ReturnType<typeof setInterval> | null = null
const snapshots = new Map<string, Snapshot>()
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

function llOn(): boolean {
  return llSupported && call.prefs.ll.enabled
}

/** The low-latency engine only encodes while someone's listening on it and you're not muted. */
function updateLLActive() {
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
  snapshots.clear()
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
  snapshots.clear()
  call.links = {}
  if (isNative) return connectNative(kind, name, code, rejoin)

  const eng = new AudioEngine(call.prefs.outputBuffer)
  engine = eng
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
  measured.clear()
  if (llSupported && eng.ctx.sampleRate === 48_000) {
    const engLL = new LowLatencyEngine(eng.ctx, call.prefs.ll, {
      link: (id, up) => session?.llState(id, up),
      relay: (to, buf) => session?.sendLL(to, buf)
    })
    engLL.inputLatencyMs = () => eng.captureLatencyMs() ?? 0
    engLL.setMic(eng.micSource)
    eng.onMic = src => engLL.setMic(src)
    ll = engLL
  }

  const iceServers = await icePromise
  if (engine !== eng) return
  const s = new Session(
    {
      name,
      muted: effectiveMuted(),
      deafened: call.deafened,
      stream: eng.sendStream,
      iceServers,
      dtx: call.prefs.dtx,
      ll: llOn() && !!ll,
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
        updateLLActive()
      },
      stream: (id, stream) => {
        if (session !== s) return
        eng.addRemote(id, stream)
        if (call.volumes[id] !== undefined) eng.setVolume(id, call.volumes[id])
        if (call.silenced[id]) eng.setSilenced(id, true)
      },
      streamEnd: id => {
        if (session === s) eng.removeRemote(id)
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
      }
    }
  )
  session = s
  if (ll) {
    const engLL = ll
    s.adoptLL = (id, ch) => engLL.adoptChannel(id, ch)
  }
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
  const icePromise = fetchIceServers()
  await v.start(appConfig())
  if (nv !== v) return
  call.micProblem = v.micProblem
  if (!rejoin && v.micProblem) toast("Couldn't open a microphone. You can listen, but nobody can hear you.", 'error', 7000)
  v.setSelf(effectiveMuted(), call.deafened)
  for (const [id, volume] of Object.entries(call.volumes)) v.setVolume(id, volume)
  for (const [id, on] of Object.entries(call.silenced)) if (on) v.setSilenced(id, true)
  measured.clear()

  const iceServers = await icePromise
  if (nv !== v) return
  const s = new Session(
    {
      name,
      muted: effectiveMuted(),
      deafened: call.deafened,
      stream: null,
      iceServers,
      dtx: call.prefs.dtx,
      ll: llOn(),
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
        v.setMembers(members)
      },
      // The app plays everyone itself.
      stream: () => {},
      streamEnd: () => {},
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
  session = null
  nv?.close()
  nv = null
  ll?.close()
  ll = null
  engine?.close()
  engine = null
  measured.clear()
  if (speakingTimer) clearInterval(speakingTimer)
  speakingTimer = null
  if (statsTimer) clearInterval(statsTimer)
  statsTimer = null
  call.links = {}
  snapshots.clear()
  // Coming straight back: keep the room on screen, everyone at the table.
  if (rejoining) return
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
      // low-latency engine's packets come in, and its jitter buffer grows
      // to cover the hiccup. So people on that engine get their ping from
      // its own pings, and the full stats are only read for the route card.
      const full = call.prefs.showRoute
      const onLL = (id: string) => !!ll && s.isLL(id)
      const [reports, llReports] = await Promise.all([
        s.getStats(id => full || !onLL(id)),
        full ? s.getLLStats() : Promise.resolve(new Map<string, RTCStatsReport>())
      ])
      if (session !== s) return
      const next: Record<string, LinkStats> = {}
      const captureMs = engine?.captureLatencyMs() ?? null
      for (const [id, report] of reports) {
        const { stats, snapshot } = summarise(report.values() as Iterable<Record<string, unknown>>, snapshots.get(id), { captureMs })
        if (snapshot) snapshots.set(id, snapshot)
        stats.measuredMs = measureWebRTC(s, id, stats.playoutMs)
        next[id] = stats
      }
      for (const m of call.members) {
        const id = m.id
        const llStats = onLL(id) ? ll?.stats(id) : null
        if (!llStats) continue
        // Route from the low-latency connection (route card only), ping from the engine's pings if
        // that's all we have; everything else from the engine.
        const report = llReports.get(id)
        const { stats } = summarise((report?.values() ?? []) as Iterable<Record<string, unknown>>, null, { captureMs })
        stats.rttMs ??= llStats.rttMs
        const cfg = call.prefs.ll
        const outMs = engine ? (engine.ctx.baseLatency + (engine.ctx.outputLatency || 0)) * 1000 : null
        const codecMs = sendDelayMs({ ...cfg, codec: llStats.codec ?? cfg.codec }) // their frame size isn't sent; ours is the best guess
        next[id] = {
          ...stats,
          engine: 'll',
          bufferMs: llStats.bufferMs,
          jitterMs: llStats.jitterMs,
          lossPct: llStats.concealedPct,
          kbps: llStats.kbps,
          codec: llStats.codec ?? cfg.codec,
          playoutMs: outMs,
          codecMs,
          mouthToEarMs:
            stats.rttMs !== null && llStats.bufferMs !== null
              ? (captureMs ?? 0) + codecMs + stats.rttMs / 2 + llStats.bufferMs + (outMs ?? 0)
              : null,
          measuredMs: llStats.measuredMs,
          ll: llStats
        }
      }
      for (const id of [...snapshots.keys()]) if (!reports.has(id)) snapshots.delete(id)
      call.links = next
    } finally {
      busy = false
    }
  }
  void poll()
  statsTimer = setInterval(poll, 1000)
}

/**
 * Mouth to ear on the WebRTC path, from the abs-capture-time header: when
 * their newest played frame was captured, when it was handed to our audio
 * output, plus Chrome's own figure for the output's delay.
 */
function measureWebRTC(s: Session, id: string, playoutMs: number | null): number | null {
  const sample = captureToSpeakerMs(s.syncSource(id), playoutMs)
  const list = measured.get(id) ?? []
  if (sample !== null) {
    list.push(sample)
    if (list.length > 5) list.shift()
    measured.set(id, list)
  }
  return median(list)
}

function median(xs: number[] | undefined): number | null {
  if (!xs?.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
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

// ---- mic test ----------------------------------------------------------------

let testTimer: ReturnType<typeof setInterval> | null = null
let testLoop: WebRTCLoopback | null = null
/** Whether we deafened you for the test (and so undeafen you after). */
let testDeafened = false

/**
 * Hear yourself, like Discord's mic test, through one path with no
 * network: raw (mic straight to the speakers: your device and the
 * browser's buffers, the floor everything else sits on), WebRTC audio (its
 * encoder, jitter buffer and playout, between two connections in this
 * tab), or the low-latency engine (its gate, encoder, packets, decoder and
 * jitter buffer). You're deafened while it runs, so you only hear yourself.
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
  } else if (path === 'webrtc') {
    const track = eng.micClone()
    if (!track) return
    testLoop = new WebRTCLoopback(track, call.prefs.dtx, call.prefs.outputId)
    await testLoop.start()
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
    } else if (t.path === 'webrtc' && testLoop) {
      const m = await testLoop.measure()
      t.ms = m.ms
      t.measured = m.ms !== null
      t.detail = m.bufferMs === null ? '' : `jitter buffer ${Math.round(m.bufferMs)} ms`
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
 * card's own callback (like pw-loopback), and low latency is the app's
 * whole engine looped back. There's no WebRTC audio stack to test.
 */
function startNativeMicTest(path: TestPath) {
  const v = nv
  if (!v || call.phase !== 'room') return
  stopMicTest()
  const p = path === 'webrtc' ? 'll' : path
  Object.assign(call.test, { on: true, path: p, ms: null, measured: false, detail: '' })
  if (!call.deafened) {
    testDeafened = true
    call.deafened = true
    pushSelfState()
  }
  v.test(p)
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
  testLoop?.stop()
  testLoop = null
  engine?.setRawLoopback(false)
  ll?.stopLoop()
  if (call.test.on && testDeafened) {
    call.deafened = false
    pushSelfState()
  }
  testDeafened = false
  call.test.on = false
}

/** What we ask senders for (DTX) is in the SDP of each call, so changing it reconnects you. */
export function setDtx(on: boolean) {
  if (on === call.prefs.dtx) return
  updatePrefs({ dtx: on })
  void rejoinCall()
}

/** Change low-latency engine settings; everything applies live. */
export function updateLL(patch: Partial<LLConfig>) {
  const next = sanitizeLL({ ...call.prefs.ll, ...patch }, isNative)
  const toggled = next.enabled !== call.prefs.ll.enabled
  updatePrefs({ ll: next })
  ll?.configure(next)
  nv?.configure(appConfig())
  if (toggled) session?.setSelf({ ll: llOn() && (!!ll || !!nv) })
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

/** Reopen the microphone with new settings and swap it into every call. */
export async function applyMicPrefs(patch: Partial<Pick<Prefs, 'inputId' | 'echoCancellation' | 'noiseSuppression' | 'autoGainControl'>>) {
  updatePrefs(patch)
  nv?.configure(appConfig())
  const eng = engine
  if (!eng) return
  const track = await eng.openMic(micSettings())
  if (engine !== eng) return
  call.micProblem = eng.micProblem
  session?.replaceTrack(track)
  pushSelfState()
}

export async function setOutput(deviceId: string) {
  updatePrefs({ outputId: deviceId })
  await engine?.setOutputDevice(deviceId)
}

/** In the app: its own devices and how it opens them (it reopens the sound card on the spot), and its processing. */
export function setAppDevices(
  patch: Partial<Pick<Prefs, 'appInputId' | 'appOutputId' | 'appExclusive' | 'noiseGate' | 'noiseGraceMs' | 'noiseLookahead' | 'agcTargetDb' | 'agcMaxDb'>>
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

/** Where someone sits, for spatial audio. Cheap to call every frame. */
export function setSeatAngle(id: string, angle: number) {
  engine?.setAngle(id, angle)
  nv?.setAngle(id, angle)
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
  ;(window as unknown as { __pv: unknown }).__pv = { call, session: () => session, ll: () => ll, engine: () => engine, native: () => nv }
}
