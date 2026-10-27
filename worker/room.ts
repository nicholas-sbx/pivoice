import { DurableObject } from 'cloudflare:workers'
import {
  CLOSE,
  MAX_MEMBERS,
  MAX_MESSAGE_CHARS,
  PING,
  PONG,
  PROTOCOL_VERSION,
  memberIdFromKey,
  parseClientMsg,
  sortMembers,
  type ClientMsg,
  type Member,
  type ServerMsg
} from '../src/net/protocol'
import type { Env } from './env'

/**
 * One room: a Durable Object per room code, so everyone with the code
 * reaches the same one, wherever they are.
 *
 * It keeps the roster (who's in, muted, deafened, on the low-latency
 * engine) and passes WebRTC offers, answers and ICE candidates between
 * members. It never sees the audio: that goes straight between members.
 *
 * Every member holds one WebSocket here, accepted with the hibernation API,
 * so a quiet room costs nothing while nobody's joining or changing state:
 * the object is evicted from memory and the sockets stay up. The keep-alive
 * pings are answered by the runtime without waking it. Everything that has
 * to outlive an eviction is on the sockets themselves (their attachments)
 * or in storage, never only in memory:
 *
 *   socket attachment  the member on that socket, once they've said hello
 *   storage 'away'     members whose socket dropped, with when they lose their seat
 *   storage 'reserved' until when a freshly made code is held for its maker
 *
 * Nothing about a room outlives it: when the last person has gone (and
 * their few seconds' grace are up), storage is wiped.
 */

interface Attachment {
  /** Set once they've said hello. */
  member: Omit<Member, 'away'> | null
  /** When the socket was accepted, ms. */
  at: number
  /** Replaced, timed out or said goodbye: no longer counts, whatever the socket's still doing. */
  gone?: boolean
}

interface Away {
  member: Member
  until: number
}

type AwayMap = Record<string, Away>

interface Live {
  ws: WebSocket
  member: Omit<Member, 'away'>
}

/** How long someone who dropped keeps their seat. */
export const AWAY_GRACE_MS = 12_000
/** A socket has this long to say hello. */
const HELLO_TIMEOUT_MS = 10_000
/** Clients ping every 5 s; this many ms of silence and they're gone. */
const STALE_AFTER_MS = 30_000
/**
 * How often a room with people in it checks for silent sockets. Each check
 * is a billed request (2,880 a day for a room that's always busy), and a
 * socket that dies without closing is rare, so not often.
 */
const SWEEP_EVERY_MS = 30_000
/** How long a new code is held for whoever made it to connect. */
const RESERVE_MS = 60_000
/** Members plus room for reconnects and people being turned away. */
const MAX_SOCKETS = MAX_MEMBERS * 2
/**
 * Per socket. Joining a full room sends an answer and a dozen candidates to
 * each of 11 people in a second or two, so the burst is generous; the
 * steady rate is not.
 */
const BUCKET_SIZE = 300
const BUCKET_REFILL_PER_S = 30

export class Room extends DurableObject<Env> {
  /** Rate limiting. Lost on eviction, which only ever refills it. */
  private buckets = new WeakMap<WebSocket, { tokens: number; at: number }>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG))
  }

  /** From the Worker: hold this code for a new room. False if it's taken. */
  async reserve(): Promise<boolean> {
    const now = Date.now()
    if (this.ctx.getWebSockets().length || Object.keys(await this.away()).length) return false
    const reserved = (await this.ctx.storage.get<number>('reserved')) ?? 0
    if (reserved > now) return false
    await this.ctx.storage.put('reserved', now + RESERVE_MS)
    await this.schedule()
    return true
  }

  /** From the Worker, already checked for origin and rate: a WebSocket upgrade. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket', { status: 426 })
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return new Response('Room is busy', { status: 503 })
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ member: null, at: Date.now() } satisfies Attachment)
    await this.schedule()
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const att = attachment(ws)
    if (!att || att.gone) return
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_CHARS) return this.reject(ws, CLOSE.bad, 'bad message')
    if (!this.take(ws)) return this.reject(ws, CLOSE.slow, 'too fast')
    let msg: ClientMsg | null = null
    try {
      msg = parseClientMsg(JSON.parse(message))
    } catch {
      /* not JSON */
    }
    if (!msg) return this.reject(ws, CLOSE.bad, 'bad message')
    if (msg.t === 'hello') return this.hello(ws, att, msg)
    const me = att.member
    if (!me) return this.reject(ws, CLOSE.bad, 'hello first')

    switch (msg.t) {
      case 'state': {
        if (me.muted === msg.muted && me.deafened === msg.deafened && me.ll === msg.ll) return
        ws.serializeAttachment({ ...att, member: { ...me, muted: msg.muted, deafened: msg.deafened, ll: msg.ll } } satisfies Attachment)
        return this.broadcastRoster()
      }
      case 'signal': {
        // Only to someone in the room right now, and always saying who it's from.
        if (msg.to === me.id) return
        const target = this.live().find(l => l.member.id === msg.to)
        if (target) send(target.ws, { t: 'signal', from: me.id, signal: msg.signal })
        return
      }
      case 'leave': {
        this.retire(ws, CLOSE.left, 'bye')
        await this.broadcastRoster()
        return this.schedule()
      }
    }
  }

  private async hello(ws: WebSocket, att: Attachment, msg: Extract<ClientMsg, { t: 'hello' }>) {
    if (att.member) return this.reject(ws, CLOSE.bad, 'already here')
    if (msg.v !== PROTOCOL_VERSION) return this.reject(ws, CLOSE.version, 'version')
    const id = await memberIdFromKey(msg.key)
    // Things may have moved on while that was hashing.
    if (attachment(ws)?.gone) return

    const now = Date.now()
    const away = await this.away()
    const live = this.live()
    const reserved = ((await this.ctx.storage.get<number>('reserved')) ?? 0) > now
    if (!live.length && !Object.keys(away).length && !reserved && msg.resume === null) return this.reject(ws, CLOSE.notFound, 'no such room')

    // Back as someone we know (a reconnect, or a second socket replacing the first): same seat, same place in line.
    const prev = live.find(l => l.member.id === id)
    const known = prev?.member ?? away[id]?.member
    if (!known && new Set([...live.map(l => l.member.id), ...Object.keys(away)]).size >= MAX_MEMBERS) {
      return this.reject(ws, CLOSE.full, 'full')
    }
    const member = {
      id,
      name: msg.name,
      joinedAt: known?.joinedAt ?? (msg.resume !== null ? Math.min(msg.resume, now) : nextJoinedAt(live, away, now)),
      muted: msg.muted,
      deafened: msg.deafened,
      ll: msg.ll
    }
    ws.serializeAttachment({ ...att, member } satisfies Attachment)
    if (prev) this.retire(prev.ws, CLOSE.replaced, 'replaced')
    if (away[id]) {
      delete away[id]
      await this.ctx.storage.put('away', away)
    }
    if (reserved) await this.ctx.storage.delete('reserved')
    send(ws, { t: 'welcome', id })
    this.broadcastRoster(away)
    await this.schedule()
  }

  async webSocketClose(ws: WebSocket) {
    await this.lost(ws)
    try {
      ws.close(CLOSE.left, 'bye')
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket) {
    await this.lost(ws)
  }

  /** Their socket's gone without a goodbye: they keep their seat for a few seconds. */
  private async lost(ws: WebSocket) {
    const att = attachment(ws)
    if (!att || att.gone || !att.member) return this.schedule()
    try {
      ws.serializeAttachment({ ...att, gone: true } satisfies Attachment)
    } catch {
      /* closed sockets may not take one; live() skips this one anyway */
    }
    await this.goAway(att.member, ws)
  }

  private async goAway(member: Omit<Member, 'away'>, ws: WebSocket) {
    const away = await this.away()
    // Already back on another socket.
    if (this.live(ws).some(l => l.member.id === member.id)) return this.schedule()
    away[member.id] = { member: { ...member, away: true }, until: Date.now() + AWAY_GRACE_MS }
    await this.ctx.storage.put('away', away)
    this.broadcastRoster(away, ws)
    await this.schedule()
  }

  async alarm() {
    const now = Date.now()
    for (const ws of this.ctx.getWebSockets()) {
      const att = attachment(ws)
      if (!att || att.gone) continue
      if (!att.member) {
        if (now - att.at > HELLO_TIMEOUT_MS) this.retire(ws, CLOSE.bad, 'no hello')
        continue
      }
      // A socket can stay open on our side long after the other end's gone; their pings say they're still there.
      const lastPing = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0
      if (now - Math.max(att.at, lastPing) > STALE_AFTER_MS) {
        this.retire(ws, CLOSE.timeout, 'timeout')
        await this.goAway(att.member, ws)
      }
    }
    const away = await this.away()
    let changed = false
    for (const [id, a] of Object.entries(away)) {
      if (a.until > now) continue
      delete away[id]
      changed = true
    }
    if (changed) {
      await this.ctx.storage.put('away', away)
      this.broadcastRoster(away)
    }
    await this.schedule()
  }

  /** Next wake-up: the soonest seat to give up or reservation to drop, and a sweep while anyone's connected. Or, with nobody left, forget the room. */
  private async schedule() {
    const now = Date.now()
    const away = await this.away()
    const reserved = (await this.ctx.storage.get<number>('reserved')) ?? 0
    let next = Infinity
    if (this.ctx.getWebSockets().some(ws => !attachment(ws)?.gone)) next = now + SWEEP_EVERY_MS
    for (const a of Object.values(away)) next = Math.min(next, a.until)
    if (reserved > now) next = Math.min(next, reserved)
    if (next === Infinity) {
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
      return
    }
    const current = await this.ctx.storage.getAlarm()
    if (current === null || current > next || current < now) await this.ctx.storage.setAlarm(Math.max(next, now + 1))
  }

  private async away(): Promise<AwayMap> {
    return (await this.ctx.storage.get<AwayMap>('away')) ?? {}
  }

  /** Everyone connected and said hello, except `skip` (a socket on its way out). */
  private live(skip?: WebSocket): Live[] {
    const out: Live[] = []
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === skip) continue
      const att = attachment(ws)
      if (att?.member && !att.gone) out.push({ ws, member: att.member })
    }
    return out
  }

  private roster(away: AwayMap, skip?: WebSocket): Member[] {
    const live = this.live(skip)
    const here = new Set(live.map(l => l.member.id))
    return sortMembers([
      ...live.map(l => ({ ...l.member, away: false })),
      ...Object.values(away)
        .filter(a => !here.has(a.member.id))
        .map(a => a.member)
    ])
  }

  private broadcastRoster(away?: AwayMap, skip?: WebSocket): void | Promise<void> {
    if (!away) return this.away().then(a => this.broadcastRoster(a, skip))
    const msg: ServerMsg = { t: 'roster', members: this.roster(away, skip) }
    for (const l of this.live(skip)) send(l.ws, msg)
  }

  private take(ws: WebSocket): boolean {
    const now = Date.now()
    const b = this.buckets.get(ws) ?? { tokens: BUCKET_SIZE, at: now }
    b.tokens = Math.min(BUCKET_SIZE, b.tokens + ((now - b.at) / 1000) * BUCKET_REFILL_PER_S)
    b.at = now
    this.buckets.set(ws, b)
    if (b.tokens < 1) return false
    b.tokens -= 1
    return true
  }

  /** Stops counting a socket, then closes it. */
  private retire(ws: WebSocket, code: number, reason: string) {
    const att = attachment(ws)
    try {
      ws.serializeAttachment({ member: att?.member ?? null, at: att?.at ?? Date.now(), gone: true } satisfies Attachment)
    } catch {
      /* closed already */
    }
    try {
      ws.close(code, reason)
    } catch {
      /* closed already */
    }
  }

  private async reject(ws: WebSocket, code: number, reason: string) {
    const att = attachment(ws)
    this.retire(ws, code, reason)
    // Someone who was in the room and broke the rules keeps their seat a moment, like any drop.
    if (att?.member && !att.gone) await this.goAway(att.member, ws)
    else await this.schedule()
  }
}

function attachment(ws: WebSocket): Attachment | null {
  try {
    return (ws.deserializeAttachment() as Attachment | null) ?? null
  } catch {
    return null
  }
}

function send(ws: WebSocket, msg: ServerMsg) {
  try {
    ws.send(JSON.stringify(msg))
  } catch {
    /* closing; its close handler deals with it */
  }
}

/** Room clock, but never before anyone already here, so a newcomer never jumps the queue. */
function nextJoinedAt(live: Live[], away: AwayMap, now: number): number {
  let latest = 0
  for (const l of live) latest = Math.max(latest, l.member.joinedAt)
  for (const a of Object.values(away)) latest = Math.max(latest, a.member.joinedAt)
  return Math.max(now, latest + 1)
}
