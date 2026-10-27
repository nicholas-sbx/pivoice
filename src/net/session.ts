import { Peer, type DataConnection, type MediaConnection, type PeerOptions } from 'peerjs'
import { generateRoomCode, isMemberPeerId, newMemberPeerId, roomPeerId } from '../lib/roomCode'
import { PROTOCOL_VERSION, parseHostMsg, successorRank, type ClientMsg, type HostMsg, type Member } from './protocol'
import { RoomHost, type ClaimResult } from './roomHost'
import { tuneOpusSdp } from './sdp'

/**
 * One person's side of a call.
 *
 * Everyone has a member PeerJS id (random) that the voice runs between: a
 * full mesh of WebRTC audio calls, no server in the middle, which is as
 * little latency as it gets. Separately, one of us holds the room id (see
 * RoomHost) and everyone else keeps a data channel to them for the roster.
 *
 * If the host goes away, the call carries on (the audio never went through
 * them) while everyone works out from the last roster who's next in join
 * order. That person claims the room id, everyone else redials it and finds
 * them there. Someone further back in the queue only tries after a delay, in
 * case the people ahead of them left too.
 */

export type SessionStatus = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'ended'
export type SessionFailure = 'not-found' | 'full' | 'unreachable' | 'unsupported' | 'version' | 'busy'

export interface SessionEvents {
  status(status: SessionStatus, failure?: SessionFailure): void
  roster(members: Member[], hostId: string): void
  stream(memberId: string, stream: MediaStream): void
  streamEnd(memberId: string): void
}

export interface SessionOptions {
  name: string
  muted: boolean
  deafened: boolean
  /** What we send to everyone. Its track can be swapped later with replaceTrack. */
  stream: MediaStream
  peerOptions: PeerOptions
  /** Ask the people talking to us to pause while they're silent (see sdp.ts). */
  dtx: boolean
}

const PEER_OPEN_TIMEOUT_MS = 15_000
const FIRST_DIAL_TIMEOUT_MS = 10_000
/** Shorter while recovering: a host that's shutting down can swallow a dial without answering. */
const RECOVER_DIAL_TIMEOUT_MS = 4_000
const FIRST_DIAL_ATTEMPTS = 3
const PING_EVERY_MS = 3_000
const HOST_DEAD_AFTER_MS = 9_000
/** How long the n-th person in the queue waits before trying to take over the room themselves. */
export const TAKEOVER_STAGGER_MS = 2_500
const RECOVER_GIVE_UP_MS = 60_000
const CALL_SETUP_TIMEOUT_MS = 20_000
const CALL_RETRY_MS = 1_500

export class Session {
  readonly selfId = newMemberPeerId()
  code = ''
  private peer: Peer | null = null
  private host: RoomHost | null = null
  private conn: DataConnection | null = null
  private calls = new Map<string, MediaConnection>()
  private callTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private members: Member[] = []
  private hostId = ''
  private self: { name: string; muted: boolean; deafened: boolean }
  private stream: MediaStream
  private options: PeerOptions
  private sdpTransform: (sdp: string) => string
  private connected = false
  private ended = false
  private lostAt = 0
  private attempts = 0
  private recovering = false
  private openTimer: ReturnType<typeof setTimeout> | null = null
  private recoverTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private peerRetryTimer: ReturnType<typeof setTimeout> | null = null
  private peerRetries = 0
  private lastHeard = 0

  constructor(
    opts: SessionOptions,
    private events: SessionEvents
  ) {
    this.self = { name: opts.name, muted: opts.muted, deafened: opts.deafened }
    this.stream = opts.stream
    this.options = opts.peerOptions
    const tuning = { dtx: opts.dtx }
    this.sdpTransform = sdp => tuneOpusSdp(sdp, tuning)
  }

  get isHost(): boolean {
    return !!this.host
  }

  /** Make a new room with a fresh code. */
  async create(): Promise<void> {
    this.events.status('connecting')
    if (!(await this.openPeer())) return
    for (let i = 0; i < 5 && !this.ended; i++) {
      const r = await this.becomeHost(generateRoomCode(), [])
      if (r === 'ok') return
      if (r === 'unsupported') return this.fail('unsupported')
      if (r === 'unreachable') return this.fail('unreachable')
    }
    if (!this.ended) this.fail('busy')
  }

  /** Join the room with this code. */
  async join(code: string): Promise<void> {
    this.code = code
    this.events.status('connecting')
    if (!(await this.openPeer())) return
    this.dial()
  }

  // ---- our own peer ------------------------------------------------------

  private openPeer(): Promise<boolean> {
    return new Promise(resolve => {
      const peer = new Peer(this.selfId, this.options)
      this.peer = peer
      const timer = setTimeout(() => {
        this.fail('unreachable')
        resolve(false)
      }, PEER_OPEN_TIMEOUT_MS)
      peer.on('open', () => {
        clearTimeout(timer)
        this.peerRetries = 0
        resolve(!this.ended)
      })
      peer.on('call', call => this.onIncomingCall(call))
      peer.on('disconnected', () => {
        // Lost the broker. Calls and the data channel are peer to peer and
        // carry on; we only need the broker to set up new ones.
        if (!this.ended && !peer.destroyed) this.reconnectPeer()
      })
      peer.on('error', err => {
        const type = (err as { type?: string }).type
        if (type === 'browser-incompatible') {
          clearTimeout(timer)
          this.fail('unsupported')
          resolve(false)
        } else if (type === 'peer-unavailable') {
          this.onPeerUnavailable(err.message)
        }
      })
    })
  }

  private reconnectPeer() {
    if (this.peerRetryTimer) return
    const delay = Math.min(10_000, 500 * 2 ** this.peerRetries++)
    this.peerRetryTimer = setTimeout(() => {
      this.peerRetryTimer = null
      const peer = this.peer
      if (this.ended || !peer || peer.destroyed || !peer.disconnected) return
      peer.reconnect()
      // `disconnected` fires again if that didn't work.
    }, delay)
  }

  /** PeerJS reports "nobody has that id" on the peer, naming the id. */
  private onPeerUnavailable(message: string) {
    if (this.code && message.includes(roomPeerId(this.code))) {
      if (this.conn && !this.conn.open) {
        this.conn.close()
        this.conn = null
        this.onDialFailed('missing')
      }
      return
    }
    for (const [id, call] of this.calls) {
      if (message.includes(id)) call.close()
    }
  }

  // ---- being the host ----------------------------------------------------

  private async becomeHost(code: string, seed: Member[]): Promise<ClaimResult> {
    const host = new RoomHost(code, this.selfMember(), this.options, {
      roster: (members, hostId) => {
        if (this.host === host) this.applyRoster(members, hostId)
      },
      displaced: () => this.onDisplaced(host)
    }, seed)
    this.host = host
    const r = await host.claim()
    if (this.host !== host || this.ended) {
      host.stop(false)
      return 'taken'
    }
    if (r !== 'ok') {
      this.host = null
      return r
    }
    this.code = code
    this.markConnected()
    return 'ok'
  }

  /** Someone else holds the room id: go and find them like everyone else. */
  private onDisplaced(host: RoomHost) {
    if (this.host !== host) return
    host.stop(false)
    this.host = null
    this.onLinkLost()
  }

  private selfMember(): Member {
    const known = this.members.find(m => m.id === this.selfId)
    return {
      id: this.selfId,
      name: this.self.name,
      joinedAt: known?.joinedAt ?? Date.now(),
      muted: this.self.muted,
      deafened: this.self.deafened,
      away: false
    }
  }

  // ---- talking to the host -----------------------------------------------

  private dial() {
    if (this.ended || this.host) return
    const peer = this.peer
    if (!peer || peer.destroyed) return this.fail('unreachable')
    this.attempts++
    if (peer.disconnected) {
      // Can't dial without the broker; try again shortly.
      return this.onDialFailed('timeout')
    }
    const conn = peer.connect(roomPeerId(this.code), { reliable: true })
    this.conn = conn
    this.clearOpenTimer()
    this.openTimer = setTimeout(
      () => {
        if (this.conn !== conn || this.lastHeard > 0) return
        conn.close()
        this.conn = null
        this.onDialFailed('timeout')
      },
      this.connected ? RECOVER_DIAL_TIMEOUT_MS : FIRST_DIAL_TIMEOUT_MS
    )
    this.lastHeard = 0

    conn.on('open', () => {
      if (this.conn !== conn) return
      this.send({ t: 'hello', v: PROTOCOL_VERSION, ...this.self })
    })
    conn.on('data', raw => {
      if (this.conn !== conn) return
      this.lastHeard = Date.now()
      const msg = parseHostMsg(raw)
      if (msg) this.onHostMessage(conn, msg)
    })
    const lost = () => {
      if (this.conn !== conn) return
      this.conn = null
      this.clearOpenTimer()
      this.stopPing()
      if (this.lastHeard > 0) this.onLinkLost()
      else this.onDialFailed('timeout')
    }
    conn.on('close', lost)
    conn.on('error', lost)
  }

  private onHostMessage(conn: DataConnection, msg: HostMsg) {
    switch (msg.t) {
      case 'roster':
        if (!msg.members.some(m => m.id === msg.hostId)) return
        this.clearOpenTimer()
        if (!this.pingTimer) this.startPing()
        this.markConnected()
        this.applyRoster(msg.members, msg.hostId)
        return
      case 'pong':
        return
      case 'full':
        return this.fail('full')
      case 'version':
        return this.fail('version')
      case 'rehome':
        // The host is leaving: don't wait to notice, start looking now.
        this.conn = null
        this.stopPing()
        conn.close()
        this.onLinkLost()
        return
    }
  }

  private onDialFailed(kind: 'missing' | 'timeout') {
    this.clearOpenTimer()
    if (this.ended) return
    if (!this.connected) {
      if (this.attempts >= FIRST_DIAL_ATTEMPTS) return this.fail(kind === 'missing' ? 'not-found' : 'unreachable')
      this.recoverTimer = setTimeout(() => this.dial(), 700)
      return
    }
    this.scheduleRecover()
  }

  private markConnected() {
    const first = !this.connected
    this.connected = true
    this.recovering = false
    this.lostAt = 0
    this.attempts = 0
    if (first || this.lastStatus !== 'connected') this.setStatus('connected')
  }

  /** We had the room and lost the host. */
  private onLinkLost() {
    if (this.ended) return
    if (!this.connected) return this.onDialFailed('timeout')
    if (!this.lostAt) this.lostAt = Date.now()
    this.attempts = 0
    this.setStatus('reconnecting')
    void this.recoverStep()
  }

  private scheduleRecover() {
    if (this.ended || this.recoverTimer) return
    const delay = Math.min(3_000, 600 * 2 ** Math.min(this.attempts, 3))
    this.recoverTimer = setTimeout(() => {
      this.recoverTimer = null
      void this.recoverStep()
    }, delay)
  }

  private async recoverStep() {
    if (this.ended || this.host || this.conn || this.recovering) return
    const elapsed = Date.now() - this.lostAt
    if (elapsed > RECOVER_GIVE_UP_MS) return this.fail('unreachable')
    const rank = successorRank(this.members, this.hostId, this.selfId)
    if (elapsed >= rank * TAKEOVER_STAGGER_MS) {
      this.recovering = true
      const seed = this.members.filter(m => m.id !== this.hostId && m.id !== this.selfId)
      const r = await this.becomeHost(this.code, seed)
      this.recovering = false
      if (r === 'ok' || this.ended) return
    }
    this.dial()
  }

  private startPing() {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastHeard > HOST_DEAD_AFTER_MS) {
        // Data channels don't always notice a host that vanished.
        const c = this.conn
        this.conn = null
        this.stopPing()
        c?.close()
        this.onLinkLost()
        return
      }
      this.send({ t: 'ping', at: Date.now() })
    }, PING_EVERY_MS)
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  private clearOpenTimer() {
    if (this.openTimer) clearTimeout(this.openTimer)
    this.openTimer = null
  }

  private send(msg: ClientMsg) {
    if (!this.conn?.open) return
    try {
      this.conn.send(msg)
    } catch {
      /* the close handler deals with it */
    }
  }

  // ---- the voice mesh ----------------------------------------------------

  private applyRoster(members: Member[], hostId: string) {
    this.members = members
    this.hostId = hostId
    this.events.roster(members, hostId)
    this.syncCalls()
    this.updateSenders()
  }

  /** One call per pair; the one with the smaller id places it, so it never happens twice. */
  private syncCalls() {
    const want = new Set(this.members.map(m => m.id))
    want.delete(this.selfId)
    for (const id of want) {
      if (!this.calls.has(id) && this.selfId < id) this.placeCall(id)
    }
    for (const id of [...this.calls.keys()]) if (!want.has(id)) this.closeCall(id)
    for (const id of [...this.retryTimers.keys()]) {
      if (!want.has(id)) {
        clearTimeout(this.retryTimers.get(id))
        this.retryTimers.delete(id)
      }
    }
  }

  private placeCall(id: string) {
    const peer = this.peer
    if (this.ended || !peer || peer.destroyed) return
    if (peer.disconnected) return this.retryCall(id)
    const call = peer.call(id, this.stream, { sdpTransform: this.sdpTransform })
    if (call) this.wireCall(call)
    else this.retryCall(id)
  }

  private onIncomingCall(call: MediaConnection) {
    if (this.ended || !isMemberPeerId(call.peer) || call.peer === this.selfId) {
      call.close()
      return
    }
    call.answer(this.stream, { sdpTransform: this.sdpTransform })
    this.wireCall(call)
  }

  private wireCall(call: MediaConnection) {
    const id = call.peer
    const prev = this.calls.get(id)
    this.calls.set(id, call)
    if (prev && prev !== call) prev.close()
    clearTimeout(this.callTimers.get(id))
    this.callTimers.set(
      id,
      setTimeout(() => {
        if (this.calls.get(id) === call && !call.remoteStream) call.close()
      }, CALL_SETUP_TIMEOUT_MS)
    )
    call.on('stream', stream => {
      if (this.calls.get(id) !== call) return
      clearTimeout(this.callTimers.get(id))
      this.callTimers.delete(id)
      prioritiseAudio(call.peerConnection)
      this.updateSenders()
      this.events.stream(id, stream)
    })
    const ended = () => this.onCallEnded(call)
    call.on('close', ended)
    call.on('error', ended)
    // PeerJS notices most dead calls, but not every one.
    const pc = call.peerConnection
    pc?.addEventListener('iceconnectionstatechange', () => {
      if (pc.iceConnectionState === 'failed') call.close()
    })
  }

  private onCallEnded(call: MediaConnection) {
    const id = call.peer
    if (this.calls.get(id) !== call) return
    this.calls.delete(id)
    clearTimeout(this.callTimers.get(id))
    this.callTimers.delete(id)
    this.events.streamEnd(id)
    if (this.selfId < id && this.members.some(m => m.id === id)) this.retryCall(id)
  }

  private retryCall(id: string) {
    if (this.ended || this.retryTimers.has(id)) return
    this.retryTimers.set(
      id,
      setTimeout(() => {
        this.retryTimers.delete(id)
        if (!this.calls.has(id) && this.members.some(m => m.id === id)) this.placeCall(id)
      }, CALL_RETRY_MS)
    )
  }

  private closeCall(id: string) {
    const call = this.calls.get(id)
    if (!call) return
    this.calls.delete(id)
    clearTimeout(this.callTimers.get(id))
    this.callTimers.delete(id)
    call.close()
    this.events.streamEnd(id)
  }

  // ---- what the UI calls -------------------------------------------------

  setSelf(patch: { muted: boolean; deafened: boolean }) {
    if (patch.muted === this.self.muted && patch.deafened === this.self.deafened) return
    this.self = { ...this.self, ...patch }
    if (this.host) this.host.updateSelf(patch)
    else this.send({ t: 'state', ...patch })
    this.updateSenders()
  }

  /** A new microphone: swap it into every call without renegotiating. */
  replaceTrack(track: MediaStreamTrack) {
    for (const old of this.stream.getAudioTracks()) if (old !== track) this.stream.removeTrack(old)
    if (!this.stream.getAudioTracks().includes(track)) this.stream.addTrack(track)
    this.updateSenders()
  }

  /**
   * Don't send audio nobody will hear. While we're muted (deafened counts),
   * or to someone who's deafened, the call's sender gets no track at all, so
   * no packets go out (a disabled track would still send encoded silence
   * 100 times a second). Swapping the track back is instant and needs no
   * renegotiation. Quiet stretches while talking are Opus DTX's job (sdp.ts).
   */
  private updateSenders() {
    const track = this.stream.getAudioTracks()[0] ?? null
    for (const [id, call] of this.calls) {
      const sender = audioSender(call.peerConnection)
      if (!sender) continue
      const deafened = this.members.find(m => m.id === id)?.deafened ?? false
      const want = this.self.muted || deafened ? null : track
      if (sender.track !== want) void sender.replaceTrack(want).catch(() => {})
    }
  }

  /** Each live call's WebRTC stats, keyed by who it's with. */
  async getStats(): Promise<Map<string, RTCStatsReport>> {
    const out = new Map<string, RTCStatsReport>()
    await Promise.all(
      [...this.calls].map(async ([id, call]) => {
        const pc = call.peerConnection
        if (!pc || !call.remoteStream) return
        try {
          out.set(id, await pc.getStats())
        } catch {
          /* closed under us */
        }
      })
    )
    return out
  }

  leave() {
    if (this.ended) return
    this.send({ t: 'leave' })
    this.host?.stop(true)
    this.teardown()
    this.setStatus('ended')
  }

  private fail(reason: SessionFailure) {
    if (this.ended) return
    this.host?.stop(true)
    this.teardown()
    this.events.status('failed', reason)
  }

  private teardown() {
    this.ended = true
    this.host = null
    this.clearOpenTimer()
    this.stopPing()
    if (this.recoverTimer) clearTimeout(this.recoverTimer)
    if (this.peerRetryTimer) clearTimeout(this.peerRetryTimer)
    for (const t of this.callTimers.values()) clearTimeout(t)
    for (const t of this.retryTimers.values()) clearTimeout(t)
    this.callTimers.clear()
    this.retryTimers.clear()
    for (const call of this.calls.values()) call.close()
    this.calls.clear()
    const conn = this.conn
    const peer = this.peer
    this.conn = null
    this.peer = null
    // Let a goodbye on the data channel get out before the peer goes.
    setTimeout(() => {
      try {
        conn?.close()
      } catch {
        /* ignore */
      }
      if (peer && !peer.destroyed) peer.destroy()
    }, 100)
  }

  private lastStatus: SessionStatus | null = null
  private setStatus(s: SessionStatus) {
    if (this.lastStatus === s) return
    this.lastStatus = s
    this.events.status(s)
  }
}

/** The one audio sender on a call, found by its transceiver so it's there even with no track on it. */
function audioSender(pc: RTCPeerConnection | undefined): RTCRtpSender | null {
  if (!pc || pc.connectionState === 'closed') return null
  const t = pc.getTransceivers().find(t => t.receiver.track?.kind === 'audio' || t.sender.track?.kind === 'audio')
  return t?.sender ?? null
}

/** Mark our audio high priority so routers that honour DSCP queue it first. */
function prioritiseAudio(pc: RTCPeerConnection | undefined) {
  if (!pc) return
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'audio') continue
    const params = sender.getParameters()
    if (!params.encodings?.length) continue
    for (const e of params.encodings as (RTCRtpEncodingParameters & { priority?: string; networkPriority?: string })[]) {
      e.priority = 'high'
      e.networkPriority = 'high'
    }
    void sender.setParameters(params).catch(() => {})
  }
}
