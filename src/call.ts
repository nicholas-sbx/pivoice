import { reactive } from 'vue'
import { AudioEngine, type MicProblem, type SpatialMode } from './audio/engine'
import { copyText } from './lib/copyText'
import { loadPrefs, savePrefs, type Prefs } from './lib/prefs'
import { fetchIceServers, peerOptions, publicUrl } from './net/config'
import type { Member } from './net/protocol'
import { Session, type SessionFailure, type SessionStatus } from './net/session'
import { summarise, type LinkStats, type Snapshot } from './net/stats'

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
  hostId: '',
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
  toasts: [] as Toast[]
})

let engine: AudioEngine | null = null
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

  const eng = new AudioEngine()
  engine = eng
  const icePromise = fetchIceServers()
  await eng.openMic(micSettings())
  if (engine !== eng) return
  call.micProblem = eng.micProblem
  if (eng.micProblem === 'denied') toast("Microphone blocked. You can listen, but nobody can hear you.", 'error', 7000)
  else if (eng.micProblem) toast("Couldn't open a microphone. You can listen, but nobody can hear you.", 'error', 7000)
  eng.setSpatial(call.prefs.spatial)
  if (call.prefs.outputId) void eng.setOutputDevice(call.prefs.outputId)
  eng.setMicEnabled(!effectiveMuted())
  eng.setDeafened(call.deafened)

  const iceServers = await icePromise
  if (engine !== eng) return
  const s = new Session(
    {
      name,
      muted: effectiveMuted(),
      deafened: call.deafened,
      stream: eng.sendStream,
      peerOptions: peerOptions(iceServers),
      dtx: call.prefs.dtx
    },
    {
      status: (status, failure) => {
        if (session !== s) return
        onStatus(status, failure)
      },
      roster: (members, hostId) => {
        if (session !== s) return
        call.members = members
        call.hostId = hostId
      },
      stream: (id, stream) => {
        if (session !== s) return
        eng.addRemote(id, stream)
        if (call.volumes[id] !== undefined) eng.setVolume(id, call.volumes[id])
        if (call.silenced[id]) eng.setSilenced(id, true)
      },
      streamEnd: id => {
        if (session === s) eng.removeRemote(id)
      }
    }
  )
  session = s
  call.selfId = s.selfId
  if (kind === 'create') await s.create()
  else await s.join(code)
}

function onStatus(status: SessionStatus, failure?: SessionFailure) {
  const wasInRoom = call.phase === 'room'
  call.status = status
  if (status === 'connected') {
    if (session) call.code = session.code
    if (call.phase !== 'room') {
      call.phase = 'room'
      call.joining = null
      // The code stays out of the address bar, like everywhere else it's hidden by default.
      if (location.hash) history.replaceState(null, '', location.pathname + location.search)
      startSpeakingPoll()
      startStatsPoll()
    }
  } else if (status === 'failed') {
    cleanup()
    call.error = wasInRoom ? 'Lost the connection to the room.' : FAILURES[failure ?? 'unreachable']
  } else if (status === 'ended') {
    cleanup()
  }
}

function cleanup() {
  session = null
  engine?.close()
  engine = null
  if (speakingTimer) clearInterval(speakingTimer)
  speakingTimer = null
  if (statsTimer) clearInterval(statsTimer)
  statsTimer = null
  call.links = {}
  snapshots.clear()
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
      const reports = await s.getStats()
      if (session !== s) return
      const next: Record<string, LinkStats> = {}
      for (const [id, report] of reports) {
        const { stats, snapshot } = summarise(report.values() as Iterable<Record<string, unknown>>, snapshots.get(id), {
          captureMs: engine?.captureLatencyMs() ?? null
        })
        if (snapshot) snapshots.set(id, snapshot)
        next[id] = stats
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
