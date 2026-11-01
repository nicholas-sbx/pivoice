import { isRoomCode } from '../lib/roomCode'
import { randomId } from '../lib/rng'
import { apiUrl, roomSocketUrl } from './config'
import { PeerLink, type Link } from './peer'
import { PROTOCOL_VERSION, newMemberKey, type ClientMsg, type Member, type Signal } from './protocol'
import { RoomSocket } from './roomSocket'

/**
 * One person's side of a call.
 *
 * The room (a Durable Object on our Worker, see worker/room.ts) keeps the
 * roster and passes signalling between us. The voice is a full mesh of
 * peer connections between members, no server in the middle, which is as
 * little latency as it gets: each carries only the low-latency engine's
 * data channel, raw PCM both ways (audio/ll). No media tracks and no codec,
 * so nothing anyone sends is ever decoded but those packets (see the
 * README, "Why no Opus"). If our socket to the room drops, the links carry
 * on while it reconnects; the room keeps our seat for a few seconds.
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
  /** The audio channel to them opened or closed. */
  llLink(memberId: string, up: boolean): void
  llPacket(memberId: string, data: ArrayBuffer): void
}

/**
 * Who makes the connections when it isn't the page: the app, when the
 * page is its UI (see native/link.ts). The session still decides who
 * dials whom and when; the links it gets just carry nothing the page can
 * see.
 */
export interface ExternalLinks {
  make(peer: string, id: string, offerer: boolean, iceServers: RTCIceServer[], signal: (s: Signal) => void): ExternalLink
}

export interface ExternalLink extends Link {
  /** The audio channel opened or closed. */
  onChannel: ((up: boolean) => void) | null
}

export interface SessionOptions {
  name: string
  muted: boolean
  deafened: boolean
  iceServers: RTCIceServer[]
  /**
   * Come back as someone we already were (see Session.drop): the room
   * still has us, marked reconnecting, so we keep our seat and place.
   */
  rejoin?: { key: string; joinedAt: number }
  /** Someone else makes the connections (the app); the page's own WebRTC otherwise. */
  links?: ExternalLinks
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
const LINK_SETUP_TIMEOUT_MS = 20_000
const LINK_RETRY_MS = 1_500
/**
 * Out of the room longer than this and the others may have dropped us
 * meanwhile (the room keeps a seat 12 s), so our links are suspect: start
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
  private members: Member[] = []
  private self: { name: string; muted: boolean; deafened: boolean }
  private llLinks = new Map<string, LLLink>()
  private llRetry = new Map<string, ReturnType<typeof setTimeout>>()
  /** Set by the app: takes a new low-latency channel (to its worker) and returns true, or leaves it with us. */
  adoptLL: ((id: string, ch: RTCDataChannel) => boolean) | null = null
  private iceServers: RTCIceServer[]
  private external: ExternalLinks | null
  private ended = false
  private downAt = 0
  private resumeAt: number | null

  constructor(
    opts: SessionOptions,
    private events: SessionEvents
  ) {
    this.key = opts.rejoin?.key ?? newMemberKey()
    this.resumeAt = opts.rejoin?.joinedAt ?? null
    this.self = { name: opts.name, muted: opts.muted, deafened: opts.deafened }
    this.iceServers = opts.iceServers
    this.external = opts.links ?? null
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

  private newLink(peer: string, id: string, offerer: boolean): Link {
    if (this.external) return this.external.make(peer, id, offerer, this.iceServers, s => this.signalTo(peer, s))
    return new PeerLink(peer, id, offerer, { iceServers: this.iceServers, signal: s => this.signalTo(peer, s) })
  }

  private onSignal(from: string, signal: Signal) {
    if (this.ended || from === this.selfId) return
    if (!this.members.some(m => m.id === from)) return
    const isOffer = 'sdp' in signal && signal.sdp.type === 'offer'
    const cur = this.llLinks.get(from)
    if (isOffer) {
      // Only the smaller id dials; a new offer means they've given up on the old one.
      if (from > this.selfId || cur?.link.id === signal.link) return
      if (cur) this.closeLL(from)
      this.acceptLL(from, signal.link, signal.sdp.sdp)
    } else if (cur?.link.id === signal.link) void cur.link.onSignal(signal)
  }

  // ---- the mesh ----------------------------------------------------------

  private applyRoster(members: Member[]) {
    this.members = members
    this.events.roster(members)
    this.syncLL()
  }

  // ---- what the UI calls -------------------------------------------------

  setSelf(patch: Partial<{ muted: boolean; deafened: boolean }>) {
    const next = { ...this.self, ...patch }
    if (next.muted === this.self.muted && next.deafened === this.self.deafened) return
    this.self = next
    this.room?.send({ t: 'state', muted: next.muted, deafened: next.deafened })
  }

  // ---- the channels ------------------------------------------------------

  /**
   * One peer connection a pair, carrying only a pre-agreed data channel
   * that's unordered and never retransmits, handed to the engine's worker
   * the moment it's made. The smaller id dials. Links to someone who's
   * away carry on, but a new one waits until they're back: nothing could
   * reach them to set it up.
   */
  private syncLL() {
    for (const m of this.members) {
      if (m.id === this.selfId || this.ended) continue
      const link = this.llLinks.get(m.id)
      if (!link && !m.away && this.selfId < m.id && this.room?.isUp && !this.llRetry.has(m.id)) this.placeLL(m.id)
    }
    for (const id of [...this.llLinks.keys()]) if (!this.members.some(m => m.id === id)) this.closeLL(id)
  }

  private placeLL(id: string) {
    const link = this.newLink(id, randomId(8), true)
    this.wireLL(id, link)
    void link.offer()
  }

  private acceptLL(id: string, linkId: string, sdp: string) {
    const link = this.newLink(id, linkId, false)
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
      }, LINK_SETUP_TIMEOUT_MS)
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
    if (!up) this.onLLClosed(id, entry)
  }

  private onLLClosed(id: string, entry: LLLink) {
    if (this.llLinks.get(id) !== entry) return
    this.closeLL(id)
    if (this.ended || this.selfId >= id) return
    // Still wanted: try again in a bit.
    this.llRetry.set(
      id,
      setTimeout(() => {
        this.llRetry.delete(id)
        this.syncLL()
      }, LINK_RETRY_MS)
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

  /** Stats for the peer connections (route and ping), keyed by who. */
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
    for (const t of this.llRetry.values()) clearTimeout(t)
    this.llRetry.clear()
    // Goodbyes on each link first, so nobody waits to notice; then off the room.
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
