import { reactive } from 'vue'
import { AudioEngine, type MicProblem, type SpatialMode } from './audio/engine'
import { LOOP_ID, sanitizeLL, sendDelayMs, type LLConfig } from './audio/ll/config'
import { WebRTCLoopback } from './audio/loopback'
import { LowLatencyEngine } from './audio/ll/engine'
import { copyText } from './lib/copyText'
import { loadPrefs, savePrefs, type Prefs } from './lib/prefs'
import { fetchIceServers, publicUrl } from './net/config'
import type { Member } from './net/protocol'
import { Session, type SessionFailure, type SessionStatus } from './net/session'
import { captureToSpeakerMs, summarise, type LinkStats, type Snapshot } from './net/stats'

/**
 * The one call this tab can be in, as reactive state for the UI, plus
 * everything the UI can do to it.
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

export const llSupported = LowLatencyEngine.supported()
let session: Session | null = null
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
    if (!engine) return
    const now = engine.speaking(call.selfId)
    const prev = call.speaking
    if (now.size === prev.size && [...now].every(id => prev.has(id))) return
    call.speaking = now
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
      ll?.refresh()
      const [reports, llReports] = await Promise.all([s.getStats(), s.getLLStats()])
      if (session !== s) return
      const next: Record<string, LinkStats> = {}
      const captureMs = engine?.captureLatencyMs() ?? null
      for (const [id, report] of reports) {
        const { stats, snapshot } = summarise(report.values() as Iterable<Record<string, unknown>>, snapshots.get(id), { captureMs })
        if (snapshot) snapshots.set(id, snapshot)
        stats.measuredMs = measureWebRTC(s, id, stats.playoutMs)
        next[id] = stats
      }
      for (const [id, report] of llReports) {
        const llStats = ll?.stats(id)
        if (!llStats) continue
        // Route and ping from the low-latency connection; everything else from the engine.
        const { stats } = summarise(report.values() as Iterable<Record<string, unknown>>, null, { captureMs })
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

export function stopMicTest() {
  if (testTimer) clearInterval(testTimer)
  testTimer = null
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
  const next = sanitizeLL({ ...call.prefs.ll, ...patch })
  const toggled = next.enabled !== call.prefs.ll.enabled
  updatePrefs({ ll: next })
  ll?.configure(next)
  if (toggled) session?.setSelf({ ll: llOn() && !!ll })
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

export function setVolume(id: string, volume: number) {
  call.volumes[id] = volume
  engine?.setVolume(id, volume)
}

export function setSilenced(id: string, on: boolean) {
  call.silenced[id] = on
  engine?.setSilenced(id, on)
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
  ;(window as unknown as { __pv: unknown }).__pv = { call, session: () => session, ll: () => ll, engine: () => engine }
}
