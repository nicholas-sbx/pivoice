import { isRoomCode } from '../lib/roomCode'
import { randomId } from '../lib/rng'
import { apiUrl, roomSocketUrl } from './config'
import { PeerLink, type Link } from './peer'
import { PROTOCOL_VERSION, newMemberKey, type ClientMsg, type LinkKind, type Member, type Signal } from './protocol'
import { RoomSocket } from './roomSocket'
import { tuneOpusSdp } from './sdp'

/**
 * One person's side of a call.
 *
 * The room (a Durable Object on our Worker, see worker/room.ts) keeps the
 * roster and passes signalling between us. The voice is a full mesh of
 * WebRTC calls between members, no server in the middle, which is as little
 * latency as it gets. If our socket to the room drops, the calls carry on
 * while it reconnects; the room keeps our seat for a few seconds.
 *
 * Who we are is a secret key we make up; the room derives our public id
 * from it, so nobody else can claim our id, and coming back with the same
 * key (Session.drop, then a new Session with `rejoin`) is coming back as the
 * same member, in the same seat.
 */

export type SessionStatus = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'ended'
export type SessionFailure = 'not-found' | 'full' | 'unreachable' | 'unsupported' | 'version' | 'busy'

export interface SessionEvents {
  status(status: SessionStatus, failure?: SessionFailure): void
  roster(members: Member[]): void
  stream(memberId: string, stream: MediaStream): void
  streamEnd(memberId: string): void
  /** A low-latency audio channel to them opened or closed. */
  llLink(memberId: string, up: boolean): void
  llPacket(memberId: string, data: ArrayBuffer): void
}

/**
 * Who makes the connections when it isn't the page: the app, when the
 * page is its UI (see native/link.ts). The session still decides who
 * calls whom and when; the links it gets just carry no media the page
 * can see.
 */
export interface ExternalLinks {
  make(peer: string, kind: LinkKind, id: string, offerer: boolean, iceServers: RTCIceServer[], signal: (s: Signal) => void): ExternalLink
}

export interface ExternalLink extends Link {
  /** The call is through (voice links). */
  onConnected: (() => void) | null
  /** The low-latency channel opened or closed (ll links). */
  onChannel: ((up: boolean) => void) | null
}

export interface SessionOptions {
  name: string
  muted: boolean
  deafened: boolean
  /** What we send to everyone. Its track can be swapped later with replaceTrack. None when the app does the sending. */
  stream: MediaStream | null
  iceServers: RTCIceServer[]
  /** Ask the people talking to us to pause while they're silent (see sdp.ts). */
  dtx: boolean
  /** Experimental low-latency engine on (see audio/ll). */
  ll: boolean
  /**
   * Come back as someone we already were (see Session.drop): the room
   * still has us, marked reconnecting, so we keep our seat and place.
   */
  rejoin?: { key: string; joinedAt: number }
  /** Someone else makes the connections (the app); the page's own WebRTC otherwise. */
  links?: ExternalLinks
}

interface Voice {
  link: Link
  connected: boolean
  /** Ours to put the mic on; the answerer gets it once the offer's in. */
  transceiver: RTCRtpTransceiver | null
  remote: MediaStream | null
  timer: ReturnType<typeof setTimeout>
}

interface LLLink {
  link: Link
  /** Only when we kept the channel (relay mode); normally the engine's worker holds it. */
  channel: RTCDataChannel | null
  up: boolean
  timer: ReturnType<typeof setTimeout>
}

/** The SCTP stream our low-latency audio channel uses, agreed in advance by both ends. */
const LL_CHANNEL_ID = 42
const CREATE_TIMEOUT_MS = 10_000
const CALL_SETUP_TIMEOUT_MS = 20_000
const CALL_RETRY_MS = 1_500
/**
 * Out of the room longer than this and the others may have dropped us
 * meanwhile (the room keeps a seat 12 s), so our calls are suspect: start
 * them again rather than wait for each to time out.
 */
const RESET_AFTER_DOWN_MS = 8_000
/** Don't queue low-latency audio behind more than this: skip the packet instead. */
const LL_MAX_BUFFERED = 16 * 1024

export class Session {
  /** Our secret. Pass it back in `rejoin` to come back as ourselves. */
  readonly key: string
  /** Our public id, once the room has told us. */
  selfId = ''
  code = ''
  private room: RoomSocket | null = null
  private voice = new Map<string, Voice>()
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private members: Member[] = []
  private self: { name: string; muted: boolean; deafened: boolean; ll: boolean }
  private llLinks = new Map<string, LLLink>()
  private llRetry = new Map<string, ReturnType<typeof setTimeout>>()
  /** Set by the app: takes a new low-latency channel (to its worker) and returns true, or leaves it with us. */
  adoptLL: ((id: string, ch: RTCDataChannel) => boolean) | null = null
  private stream: MediaStream | null
  private iceServers: RTCIceServer[]
  private external: ExternalLinks | null
  private sdpTransform: (sdp: string) => string
  private ended = false
  private downAt = 0
  private resumeAt: number | null

  constructor(
    opts: SessionOptions,
    private events: SessionEvents
  ) {
    this.key = opts.rejoin?.key ?? newMemberKey()
    this.resumeAt = opts.rejoin?.joinedAt ?? null
    this.self = { name: opts.name, muted: opts.muted, deafened: opts.deafened, ll: opts.ll }
    this.stream = opts.stream
    this.iceServers = opts.iceServers
    this.external = opts.links ?? null
    const tuning = { dtx: opts.dtx }
    this.sdpTransform = sdp => tuneOpusSdp(sdp, tuning)
  }

  /** When we joined, room clock: what `rejoin` needs. */
  get joinedAt(): number | null {
    return this.members.find(m => m.id === this.selfId)?.joinedAt ?? this.resumeAt
  }

  /** Make a new room. The Worker picks the code. */
  async create(): Promise<void> {
    this.events.status('connecting')
    if (!this.supported()) return this.fail('unsupported')
    let code = ''
    try {
      const res = await fetch(apiUrl('rooms'), { method: 'POST', signal: AbortSignal.timeout(CREATE_TIMEOUT_MS) })
      if (res.status === 503) return this.fail('busy')
      const body = res.ok ? ((await res.json()) as { code?: unknown }) : {}
      if (typeof body.code === 'string' && isRoomCode(body.code)) code = body.code
    } catch {
      /* below */
    }
    if (this.ended) return
    if (!code) return this.fail('unreachable')
    this.connect(code)
  }

  /** Join the room with this code. */
  async join(code: string): Promise<void> {
    this.events.status('connecting')
    if (!this.supported()) return this.fail('unsupported')
    this.connect(code)
  }

  // ---- the room ----------------------------------------------------------

  private connect(code: string) {
    this.code = code
    const room: RoomSocket = new RoomSocket(roomSocketUrl(code), () => this.hello(), {
      welcome: id => this.room === room && this.onWelcome(id),
      roster: members => this.room === room && this.applyRoster(members),
      signal: (from, signal) => this.room === room && this.onSignal(from, signal),
      down: () => {
        if (this.room !== room) return
        this.downAt = Date.now()
        this.setStatus('reconnecting')
      },
      failed: reason => this.room === room && this.fail(reason)
    })
    this.room = room
    room.open()
  }

  private hello(): ClientMsg {
    return { t: 'hello', v: PROTOCOL_VERSION, key: this.key, ...this.self, resume: this.joinedAt }
  }

  private onWelcome(id: string) {
    this.selfId = id
    const downFor = this.downAt ? Date.now() - this.downAt : 0
    this.downAt = 0
    if (downFor > RESET_AFTER_DOWN_MS) {
      // The roster that follows sets them all up again.
      for (const v of [...this.voice.values()]) v.link.close()
      for (const id of [...this.llLinks.keys()]) this.closeLL(id)
    }
    this.setStatus('connected')
  }

  private signalTo(to: string, signal: Signal) {
    this.room?.send({ t: 'signal', to, signal })
  }

  private supported(): boolean {
    return this.external ? typeof WebSocket !== 'undefined' : supported()
  }

  private newLink(peer: string, kind: LinkKind, id: string, offerer: boolean): Link {
    if (this.external) return this.external.make(peer, kind, id, offerer, this.iceServers, s => this.signalTo(peer, s))
    return new PeerLink(peer, kind, id, offerer, {
      iceServers: this.iceServers,
      sdpTransform: kind === 'voice' ? this.sdpTransform : undefined,
      signal: s => this.signalTo(peer, s)
    })
  }

  private onSignal(from: string, signal: Signal) {
    if (this.ended || from === this.selfId) return
    const member = this.members.find(m => m.id === from)
    if (!member) return
    const isOffer = 'sdp' in signal && signal.sdp.type === 'offer'
    if (signal.kind === 'voice') {
      const cur = this.voice.get(from)
      if (isOffer) {
        // Only the smaller id calls; a new offer means they've given up on the old one.
        if (from > this.selfId || cur?.link.id === signal.link) return
        if (cur) cur.link.close(false)
        this.acceptCall(from, signal.link, signal.sdp.sdp)
      } else if (cur?.link.id === signal.link) void cur.link.onSignal(signal)
      return
    }
    const cur = this.llLinks.get(from)
    if (isOffer) {
      if (from > this.selfId || cur?.link.id === signal.link) return
      if (cur) this.closeLL(from)
      if (!this.self.ll || !member.ll) return this.signalTo(from, { kind: 'll', link: signal.link, bye: true })
      this.acceptLL(from, signal.link, signal.sdp.sdp)
    } else if (cur?.link.id === signal.link) void cur.link.onSignal(signal)
  }

  // ---- the voice mesh ----------------------------------------------------

  private applyRoster(members: Member[]) {
    this.members = members
    this.events.roster(members)
    this.syncCalls()
    this.syncLL()
    this.updateSenders()
  }

  /**
   * One call per pair; the one with the smaller id places it, so it never
   * happens twice. Calls to someone who's away carry on, but a new one waits
   * until they're back: nothing could reach them to set it up.
   */
  private syncCalls() {
    const want = new Set(this.members.map(m => m.id))
    want.delete(this.selfId)
    for (const m of this.members) {
      if (want.has(m.id) && !m.away && !this.voice.has(m.id) && this.selfId < m.id && !this.retryTimers.has(m.id)) this.placeCall(m.id)
    }
    for (const [id, v] of [...this.voice]) if (!want.has(id)) v.link.close()
    for (const [id, t] of [...this.retryTimers]) {
      if (want.has(id)) continue
      clearTimeout(t)
      this.retryTimers.delete(id)
    }
  }

  private placeCall(id: string) {
    if (this.ended || !this.room?.isUp) return this.retryCall(id)
    const link = this.newLink(id, 'voice', randomId(8), true)
    const transceiver = link instanceof PeerLink ? link.pc.addTransceiver('audio', { direction: 'sendrecv', streams: this.stream ? [this.stream] : [] }) : null
    this.wireCall(id, link, transceiver)
    void link.offer()
  }

  private acceptCall(id: string, linkId: string, sdp: string) {
    const link = this.newLink(id, 'voice', linkId, false)
    const v = this.wireCall(id, link, null)
    if (!(link instanceof PeerLink)) return void link.answer(sdp)
    void link.answer(sdp, () => {
      const t = link.pc.getTransceivers().find(t => t.receiver.track.kind === 'audio')
      if (!t) return
      t.direction = 'sendrecv'
      if (this.stream) t.sender.setStreams?.(this.stream)
      v.transceiver = t
      this.updateSenders()
    })
  }

  private wireCall(id: string, link: Link, transceiver: RTCRtpTransceiver | null): Voice {
    const v: Voice = {
      link,
      connected: false,
      transceiver,
      remote: null,
      timer: setTimeout(() => {
        if (!v.connected) link.close()
      }, CALL_SETUP_TIMEOUT_MS)
    }
    this.voice.set(id, v)
    link.onClose = () => this.onCallEnded(id, v)
    if (!(link instanceof PeerLink)) {
      // The app plays their voice itself; all we need to know is that it got through.
      ;(link as ExternalLink).onConnected = () => {
        v.connected = true
        clearTimeout(v.timer)
      }
      return v
    }
    link.pc.ontrack = e => {
      if (this.voice.get(id) !== v || e.track.kind !== 'audio') return
      v.remote = e.streams[0] ?? new MediaStream([e.track])
      this.events.stream(id, v.remote)
    }
    link.pc.addEventListener('connectionstatechange', () => {
      if (link.pc.connectionState !== 'connected' || this.voice.get(id) !== v) return
      v.connected = true
      clearTimeout(v.timer)
      prioritiseAudio(link.pc)
    })
    this.updateSenders()
    return v
  }

  private onCallEnded(id: string, v: Voice) {
    clearTimeout(v.timer)
    if (this.voice.get(id) !== v) return
    this.voice.delete(id)
    this.events.streamEnd(id)
    if (this.selfId < id && this.members.some(m => m.id === id)) this.retryCall(id)
  }

  private retryCall(id: string) {
    if (this.ended || this.retryTimers.has(id)) return
    this.retryTimers.set(
      id,
      setTimeout(() => {
        this.retryTimers.delete(id)
        if (!this.voice.has(id) && this.members.some(m => m.id === id && !m.away)) this.placeCall(id)
      }, CALL_RETRY_MS)
    )
  }

  // ---- what the UI calls -------------------------------------------------

  setSelf(patch: Partial<{ muted: boolean; deafened: boolean; ll: boolean }>) {
    const next = { ...this.self, ...patch }
    if (next.muted === this.self.muted && next.deafened === this.self.deafened && next.ll === this.self.ll) return
    this.self = next
    this.room?.send({ t: 'state', muted: next.muted, deafened: next.deafened, ll: next.ll })
    this.syncLL()
    this.updateSenders()
  }

  /** A new microphone: swap it into every call without renegotiating. */
  replaceTrack(track: MediaStreamTrack) {
    if (!this.stream) return
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
    const track = this.stream?.getAudioTracks()[0] ?? null
    for (const [id, v] of this.voice) {
      const sender = v.transceiver?.sender
      if (!sender || v.link.closed) continue
      const deafened = this.members.find(m => m.id === id)?.deafened ?? false
      // Someone we're reaching over the low-latency engine doesn't need it twice.
      const viaLL = this.llLinks.get(id)?.up ?? false
      const want = this.self.muted || deafened || viaLL ? null : track
      if (sender.track !== want) void sender.replaceTrack(want).catch(() => {})
    }
  }

  // ---- the low-latency engine's channels --------------------------------

  /**
   * Pairs who both have the engine on get a second peer connection, carrying
   * only a pre-agreed data channel that's unordered and never retransmits.
   * It's its own connection so it can come and go without touching the
   * call, and so the channel can be handed to the engine's worker the moment
   * it's made. As with calls, the smaller id dials.
   */
  private syncLL() {
    for (const m of this.members) {
      if (m.id === this.selfId) continue
      const want = this.self.ll && m.ll && !this.ended
      const link = this.llLinks.get(m.id)
      if (want && !link && !m.away && this.selfId < m.id && this.room?.isUp && !this.llRetry.has(m.id)) this.placeLL(m.id)
      else if (!want && link) this.closeLL(m.id)
    }
    for (const id of [...this.llLinks.keys()]) if (!this.members.some(m => m.id === id)) this.closeLL(id)
  }

  private placeLL(id: string) {
    const link = this.newLink(id, 'll', randomId(8), true)
    this.wireLL(id, link)
    void link.offer()
  }

  private acceptLL(id: string, linkId: string, sdp: string) {
    const link = this.newLink(id, 'll', linkId, false)
    this.wireLL(id, link)
    void link.answer(sdp)
  }

  private wireLL(id: string, link: Link) {
    const entry: LLLink = {
      link,
      channel: null,
      up: false,
      timer: setTimeout(() => {
        if (!entry.up) link.close()
      }, CALL_SETUP_TIMEOUT_MS)
    }
    this.llLinks.set(id, entry)
    link.onClose = () => this.onLLClosed(id, entry)
    if (!(link instanceof PeerLink)) {
      // The app holds the channel; it tells us when it opens and closes.
      ;(link as ExternalLink).onChannel = up => this.llState(id, up)
      return
    }
    // Made before the offer, so it's in it; negotiated, so both ends make the same one.
    const ch = link.pc.createDataChannel('pv-audio', { negotiated: true, id: LL_CHANNEL_ID, ordered: false, maxRetransmits: 0 })
    // Straight to the engine's worker if it'll take it (it then tells us
    // via llState when it opens and closes); otherwise we keep it and relay.
    if (this.adoptLL?.(id, ch)) return
    entry.channel = ch
    ch.binaryType = 'arraybuffer'
    ch.onopen = () => this.llState(id, true)
    ch.onmessage = e => {
      if (e.data instanceof ArrayBuffer) this.events.llPacket(id, e.data)
    }
    ch.onclose = () => this.llState(id, false)
  }

  /** The low-latency channel to them opened or closed (whoever holds it). */
  llState(id: string, up: boolean) {
    const entry = this.llLinks.get(id)
    if (!entry || entry.up === up) return
    entry.up = up
    if (up) clearTimeout(entry.timer)
    this.events.llLink(id, up)
    this.updateSenders()
    if (!up) this.onLLClosed(id, entry)
  }

  private onLLClosed(id: string, entry: LLLink) {
    if (this.llLinks.get(id) !== entry) return
    this.closeLL(id)
    if (this.ended || !this.self.ll || this.selfId >= id) return
    // Still wanted: try again in a bit.
    this.llRetry.set(
      id,
      setTimeout(() => {
        this.llRetry.delete(id)
        this.syncLL()
      }, CALL_RETRY_MS)
    )
  }

  private closeLL(id: string) {
    const entry = this.llLinks.get(id)
    if (!entry) return
    this.llLinks.delete(id)
    clearTimeout(entry.timer)
    try {
      entry.channel?.close()
    } catch {
      /* already gone */
    }
    entry.link.close()
    if (entry.up) this.events.llLink(id, false)
    this.updateSenders()
  }

  /** Relay mode only: send low-latency packets on the channels we kept. Late is dropped, never queued. */
  sendLL(to: string[], data: ArrayBuffer) {
    for (const id of to) {
      const ch = this.llLinks.get(id)?.channel
      if (!ch || ch.readyState !== 'open' || ch.bufferedAmount > LL_MAX_BUFFERED) continue
      try {
        ch.send(data)
      } catch {
        /* closing */
      }
    }
  }

  /** How many people we're sending low-latency audio to right now. */
  llListeners(): number {
    let n = 0
    for (const [id, link] of this.llLinks) if (link.up && !this.members.find(m => m.id === id)?.deafened) n++
    return n
  }

  isLL(id: string): boolean {
    return this.llLinks.get(id)?.up ?? false
  }

  /** Stats for the peer connections carrying low-latency audio (route and ping), keyed by who. */
  async getLLStats(): Promise<Map<string, RTCStatsReport>> {
    const out = new Map<string, RTCStatsReport>()
    await Promise.all(
      [...this.llLinks].map(async ([id, entry]) => {
        if (!entry.up || !(entry.link instanceof PeerLink)) return
        try {
          out.set(id, await entry.link.pc.getStats())
        } catch {
          /* closed under us */
        }
      })
    )
    return out
  }

  /**
   * The newest audio frame of theirs played out, with the time it was
   * captured at their end (the abs-capture-time header, see sdp.ts) and the
   * time it was handed to our speakers.
   */
  syncSource(id: string): RTCRtpSynchronizationSource | null {
    const receiver = this.voice.get(id)?.transceiver?.receiver
    return receiver?.getSynchronizationSources()[0] ?? null
  }

  /** Each live call's WebRTC stats (or just the ones `want` picks), keyed by who it's with. */
  async getStats(want: (id: string) => boolean = () => true): Promise<Map<string, RTCStatsReport>> {
    const out = new Map<string, RTCStatsReport>()
    await Promise.all(
      [...this.voice].map(async ([id, v]) => {
        if (!v.remote || v.link.closed || !want(id) || !(v.link instanceof PeerLink)) return
        try {
          out.set(id, await v.link.pc.getStats())
        } catch {
          /* closed under us */
        }
      })
    )
    return out
  }

  leave() {
    if (this.ended) return
    this.teardown(true)
    this.setStatus('ended')
  }

  /**
   * Go without saying goodbye, to come straight back as the same member
   * (see SessionOptions.rejoin): the room keeps us as reconnecting for a
   * few seconds, so we keep our seat.
   */
  drop() {
    if (this.ended) return
    this.teardown(false)
    this.setStatus('ended')
  }

  private fail(reason: SessionFailure) {
    if (this.ended) return
    this.teardown(false)
    this.events.status('failed', reason)
  }

  private teardown(leave: boolean) {
    this.ended = true
    for (const t of this.retryTimers.values()) clearTimeout(t)
    for (const t of this.llRetry.values()) clearTimeout(t)
    this.retryTimers.clear()
    this.llRetry.clear()
    // Goodbyes on each link first, so nobody waits to notice; then off the room.
    for (const v of [...this.voice.values()]) v.link.close()
    for (const id of [...this.llLinks.keys()]) this.closeLL(id)
    this.room?.close(leave)
  }

  private lastStatus: SessionStatus | null = null
  private setStatus(s: SessionStatus) {
    if (this.lastStatus === s) return
    this.lastStatus = s
    this.events.status(s)
  }
}

function supported(): boolean {
  return typeof RTCPeerConnection !== 'undefined' && typeof WebSocket !== 'undefined'
}

/** Mark our audio high priority so routers that honour DSCP queue it first. Even with no track on it yet (muted). */
function prioritiseAudio(pc: RTCPeerConnection) {
  for (const t of pc.getTransceivers()) {
    if (t.receiver.track.kind !== 'audio' || t.currentDirection === 'stopped') continue
    const params = t.sender.getParameters()
    if (!params.encodings?.length) continue
    for (const e of params.encodings as (RTCRtpEncodingParameters & { priority?: string; networkPriority?: string })[]) {
      e.priority = 'high'
      e.networkPriority = 'high'
    }
    void t.sender.setParameters(params).catch(() => {})
  }
}
