import { Peer, type DataConnection, type PeerOptions } from 'peerjs'
import { isMemberPeerId, roomPeerId } from '../lib/roomCode'
import {
  MAX_MEMBERS,
  PROTOCOL_VERSION,
  parseClientMsg,
  sortMembers,
  type ClientMsg,
  type HostMsg,
  type Member
} from './protocol'

/**
 * The room, when this tab is the one holding it.
 *
 * The room *is* a PeerJS id: we register `pivoice-v1-room-<CODE>` on the
 * broker and everyone who knows the code connects straight to it, so the free
 * PeerJS broker doubles as the room directory (the gasmoney trick) and we run
 * no server of our own. The host only keeps the roster (who's in, muted,
 * deafened) and hands it out; the voice goes directly between members.
 *
 * Whoever holds the id is the host, and anyone can become it: when the host
 * leaves, the next person in join order claims the id and everyone else
 * finds them there (see Session).
 */

export type ClaimResult = 'ok' | 'taken' | 'unreachable' | 'unsupported'

export interface RoomHostEvents {
  roster(members: Member[], hostId: string): void
  /** Somebody else holds the room id now; stop being the host and go find them. */
  displaced(): void
}

interface Link {
  conn: DataConnection
  memberId: string
  lastSeen: number
  tokens: number
  tokensAt: number
}

const CLAIM_TIMEOUT_MS = 10_000
const LINK_TIMEOUT_MS = 12_000
/** How long someone who dropped (or who hasn't found the new host yet) keeps their seat. */
export const AWAY_GRACE_MS = 12_000
const BUCKET_SIZE = 30
const BUCKET_REFILL_PER_S = 10
/** Re-registration refused this many times in a row means someone else really has the room. */
const DISPLACED_AFTER = 3

export class RoomHost {
  private peer: Peer | null = null
  private links = new Map<string, Link>()
  private members = new Map<string, Member>()
  /** Member id → when they lose their seat if they haven't said hello by then. */
  private awayUntil = new Map<string, number>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private refusedInARow = 0
  private stopped = false
  private broadcastQueued = false

  constructor(
    readonly code: string,
    private self: Member,
    private options: PeerOptions,
    private events: RoomHostEvents,
    /** The last roster we saw under the previous host, so nobody flickers off the table while they find us. */
    seed: Member[] = []
  ) {
    this.members.set(self.id, { ...self, away: false })
    const now = Date.now()
    for (const m of seed) {
      if (m.id === self.id || this.members.has(m.id)) continue
      this.members.set(m.id, { ...m, away: true })
      this.awayUntil.set(m.id, now + AWAY_GRACE_MS)
    }
  }

  get hostId(): string {
    return this.self.id
  }

  /** Try to take the room id on the broker. */
  claim(): Promise<ClaimResult> {
    return new Promise(resolve => {
      let settled = false
      const done = (r: ClaimResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (r !== 'ok') this.destroyPeer()
        resolve(r)
      }
      const timer = setTimeout(() => done('unreachable'), CLAIM_TIMEOUT_MS)
      const peer = new Peer(roomPeerId(this.code), this.options)
      this.peer = peer

      peer.on('open', () => {
        if (this.peer !== peer) return
        this.reconnectAttempts = 0
        this.refusedInARow = 0
        if (!settled) {
          this.startSweep()
          this.emitRoster()
          done('ok')
        }
      })

      peer.on('connection', conn => this.accept(conn))

      peer.on('disconnected', () => {
        // Lost the broker, not the members: our data channels are peer to peer.
        if (this.stopped || peer.destroyed || this.peer !== peer || !settled) return
        this.scheduleReconnect()
      })

      peer.on('error', err => {
        if (this.peer !== peer) return
        const type = (err as { type?: string }).type
        if (!settled) {
          if (type === 'unavailable-id') done('taken')
          else if (type === 'browser-incompatible') done('unsupported')
          else if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed')
            done('unreachable')
          return
        }
        if (type === 'unavailable-id') {
          // Re-registering after a broker hiccup and the id is taken. The
          // first few times that's usually our own old session lingering;
          // after that, someone has taken over the room.
          if (++this.refusedInARow >= DISPLACED_AFTER) {
            this.broadcast({ t: 'rehome' })
            this.events.displaced()
          } else this.scheduleReconnect()
          return
        }
        if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
          this.scheduleReconnect()
        }
      })
    })
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.stopped) return
    const delay = Math.min(10_000, 1_000 * 2 ** this.reconnectAttempts)
    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      const peer = this.peer
      if (this.stopped || !peer || peer.destroyed) return
      if (peer.disconnected) peer.reconnect()
    }, delay)
  }

  private accept(conn: DataConnection) {
    if (this.stopped || !isMemberPeerId(conn.peer) || conn.peer === this.self.id) {
      conn.on('open', () => conn.close())
      return
    }
    const now = Date.now()
    const link: Link = { conn, memberId: conn.peer, lastSeen: now, tokens: BUCKET_SIZE, tokensAt: now }
    conn.on('data', raw => {
      const t = Date.now()
      link.lastSeen = t
      link.tokens = Math.min(BUCKET_SIZE, link.tokens + ((t - link.tokensAt) / 1000) * BUCKET_REFILL_PER_S)
      link.tokensAt = t
      if (link.tokens < 1) return
      link.tokens -= 1
      const msg = parseClientMsg(raw)
      if (msg) this.onMessage(link, msg)
    })
    conn.on('close', () => this.dropLink(link, false))
    conn.on('error', () => this.dropLink(link, false))
  }

  private onMessage(link: Link, msg: ClientMsg) {
    const id = link.memberId
    switch (msg.t) {
      case 'hello': {
        if (msg.v !== PROTOCOL_VERSION) {
          this.send(link, { t: 'version', need: PROTOCOL_VERSION })
          setTimeout(() => link.conn.close(), 500)
          return
        }
        const existing = this.members.get(id)
        if (!existing && this.members.size >= MAX_MEMBERS) {
          this.send(link, { t: 'full' })
          setTimeout(() => link.conn.close(), 500)
          return
        }
        // A second tab/connection for the same member replaces the first.
        const old = this.links.get(id)
        if (old && old !== link) this.dropLink(old, true)
        this.links.set(id, link)
        this.awayUntil.delete(id)
        this.members.set(id, {
          id,
          name: msg.name,
          // Keep their place in the queue if they were already here.
          joinedAt: existing?.joinedAt ?? this.nextJoinedAt(),
          muted: msg.muted,
          deafened: msg.deafened,
          away: false
        })
        this.emitRoster()
        return
      }
      case 'state': {
        const m = this.members.get(id)
        if (!m || this.links.get(id) !== link) return
        if (m.muted === msg.muted && m.deafened === msg.deafened) return
        this.members.set(id, { ...m, muted: msg.muted, deafened: msg.deafened })
        this.emitRoster()
        return
      }
      case 'ping':
        this.send(link, { t: 'pong', at: msg.at })
        return
      case 'leave':
        if (this.links.get(id) === link) {
          this.links.delete(id)
          this.members.delete(id)
          this.awayUntil.delete(id)
          this.emitRoster()
        }
        link.conn.close()
        return
    }
  }

  /** Host clock, but never before anyone already here, so a newcomer never jumps the queue. */
  private nextJoinedAt(): number {
    let latest = 0
    for (const m of this.members.values()) latest = Math.max(latest, m.joinedAt)
    return Math.max(Date.now(), latest + 1)
  }

  /** A link went quiet or closed. They keep their seat for a little while in case they're back. */
  private dropLink(link: Link, replaced: boolean) {
    try {
      link.conn.close()
    } catch {
      /* already closed */
    }
    if (this.links.get(link.memberId) !== link) return
    this.links.delete(link.memberId)
    if (replaced || this.stopped) return
    const m = this.members.get(link.memberId)
    if (!m) return
    this.members.set(m.id, { ...m, away: true })
    this.awayUntil.set(m.id, Date.now() + AWAY_GRACE_MS)
    this.emitRoster()
  }

  private startSweep() {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => {
      const now = Date.now()
      for (const link of [...this.links.values()]) {
        if (now - link.lastSeen > LINK_TIMEOUT_MS) this.dropLink(link, false)
      }
      let changed = false
      for (const [id, until] of [...this.awayUntil]) {
        if (now < until) continue
        this.awayUntil.delete(id)
        this.members.delete(id)
        changed = true
      }
      if (changed) this.emitRoster()
    }, 2_000)
  }

  updateSelf(patch: Partial<Pick<Member, 'muted' | 'deafened'>>) {
    this.self = { ...this.self, ...patch }
    this.members.set(this.self.id, { ...this.self, away: false })
    this.emitRoster()
  }

  roster(): Member[] {
    return sortMembers([...this.members.values()])
  }

  /** Coalesces a burst of changes into one roster message. */
  private emitRoster() {
    if (this.broadcastQueued) return
    this.broadcastQueued = true
    queueMicrotask(() => {
      this.broadcastQueued = false
      if (this.stopped) return
      const members = this.roster()
      this.broadcast({ t: 'roster', hostId: this.self.id, members })
      this.events.roster(members, this.self.id)
    })
  }

  private send(link: Link, msg: HostMsg) {
    if (!link.conn.open) return
    try {
      link.conn.send(msg)
    } catch (e) {
      console.warn('send failed', e)
    }
  }

  private broadcast(msg: HostMsg) {
    for (const link of this.links.values()) this.send(link, msg)
  }

  private destroyPeer() {
    if (this.peer && !this.peer.destroyed) this.peer.destroy()
    this.peer = null
  }

  /** `handOver`: tell everyone to go and find the next host straight away instead of waiting to notice. */
  stop(handOver: boolean) {
    if (this.stopped) return
    if (handOver) this.broadcast({ t: 'rehome' })
    this.stopped = true
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.sweepTimer = null
    this.reconnectTimer = null
    const links = [...this.links.values()]
    this.links.clear()
    // Give the rehome a moment to leave before the channels close under it.
    setTimeout(
      () => {
        for (const l of links) {
          try {
            l.conn.close()
          } catch {
            /* ignore */
          }
        }
        this.destroyPeer()
      },
      handOver ? 150 : 0
    )
  }
}
