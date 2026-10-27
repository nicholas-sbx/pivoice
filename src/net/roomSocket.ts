import { CLOSE, MAX_MESSAGE_CHARS, PING, PONG, parseServerMsg, type ClientMsg, type Member, type Signal } from './protocol'

/**
 * Our WebSocket into the room (a Durable Object, see worker/room.ts): the
 * roster comes in on it, and offers, answers and ICE candidates go both
 * ways. It reconnects on its own when it drops; the calls themselves are
 * peer to peer and carry on meanwhile.
 */

export type RoomFailure = 'not-found' | 'full' | 'version' | 'unreachable'

export interface RoomSocketEvents {
  /** We're in (again). Always comes before the roster. */
  welcome(id: string): void
  roster(members: Member[]): void
  signal(from: string, signal: Signal): void
  /** Lost the room; already trying to get back. */
  down(): void
  failed(reason: RoomFailure): void
}

/** The room answers these without waking up, and closes sockets that stop sending them. */
const PING_EVERY_MS = 5_000
/** Nothing back for this long and the socket's dead, whatever it says. */
const DEAD_AFTER_MS = 12_000
const OPEN_TIMEOUT_MS = 10_000
const FIRST_ATTEMPTS = 3
const GIVE_UP_MS = 60_000

export class RoomSocket {
  private ws: WebSocket | null = null
  /** This socket has been welcomed. */
  private up = false
  /** Some socket has, so we're reconnecting rather than joining. */
  private everUp = false
  private attempts = 0
  private lostAt = 0
  private lastHeard = 0
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(
    private url: string,
    /** Asked for afresh on every connect, so it always carries our current state. */
    private hello: () => ClientMsg,
    private events: RoomSocketEvents
  ) {}

  open() {
    this.connect()
  }

  get isUp(): boolean {
    return this.up
  }

  send(msg: ClientMsg) {
    const ws = this.ws
    if (!ws || !this.up || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(msg))
  }

  /** `leave`: say goodbye, so we lose our seat now instead of after the grace period. */
  close(leave: boolean) {
    if (this.closed) return
    if (leave) this.send({ t: 'leave' })
    this.closed = true
    this.stop()
    const ws = this.ws
    this.ws = null
    this.up = false
    try {
      ws?.close(CLOSE.left)
    } catch {
      /* closed already */
    }
  }

  private connect() {
    if (this.closed) return
    this.attempts++
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch {
      return this.retry()
    }
    this.ws = ws
    this.up = false
    this.lastHeard = Date.now()
    const openTimer = setTimeout(() => {
      if (this.ws === ws && !this.up) this.lost(ws, 0)
    }, OPEN_TIMEOUT_MS)

    ws.onopen = () => {
      if (this.ws !== ws) return
      ws.send(JSON.stringify(this.hello()))
      this.startPing(ws)
    }
    ws.onmessage = e => {
      if (this.ws !== ws) return
      this.lastHeard = Date.now()
      if (typeof e.data !== 'string' || e.data === PONG || e.data.length > MAX_MESSAGE_CHARS) return
      let msg = null
      try {
        msg = parseServerMsg(JSON.parse(e.data))
      } catch {
        /* not ours */
      }
      if (!msg) return
      if (msg.t === 'welcome') {
        clearTimeout(openTimer)
        this.up = true
        this.everUp = true
        this.attempts = 0
        this.lostAt = 0
        this.events.welcome(msg.id)
      } else if (!this.up) return
      else if (msg.t === 'roster') this.events.roster(msg.members)
      else this.events.signal(msg.from, msg.signal)
    }
    ws.onclose = e => {
      clearTimeout(openTimer)
      this.lost(ws, e.code)
    }
    // An error is always followed by a close.
  }

  private lost(ws: WebSocket, code: number) {
    if (this.ws !== ws || this.closed) return
    this.ws = null
    this.stop()
    try {
      ws.close()
    } catch {
      /* closed already */
    }
    const wasUp = this.up
    this.up = false
    if (code === CLOSE.full) return this.fail('full')
    if (code === CLOSE.version) return this.fail('version')
    if (code === CLOSE.notFound) return this.fail('not-found')
    // Only another socket of ours could have replaced this one, and it's the one that counts.
    if (code === CLOSE.replaced) return this.fail('unreachable')
    if (wasUp) {
      this.lostAt = Date.now()
      this.events.down()
    }
    this.retry()
  }

  private retry() {
    if (this.closed || this.retryTimer) return
    if (this.everUp ? Date.now() - this.lostAt > GIVE_UP_MS : this.attempts >= FIRST_ATTEMPTS) return this.fail('unreachable')
    // Backed off and spread out, so a room full of people coming back after a deploy don't all knock at once.
    const delay = Math.min(5_000, 400 * 2 ** Math.min(this.attempts, 4)) * (0.75 + Math.random() / 2)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
  }

  private startPing(ws: WebSocket) {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => {
      if (this.ws !== ws) return
      if (Date.now() - this.lastHeard > DEAD_AFTER_MS) return this.lost(ws, 0)
      try {
        ws.send(PING)
      } catch {
        /* the close handler deals with it */
      }
    }, PING_EVERY_MS)
  }

  private stop() {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.pingTimer = null
    this.retryTimer = null
  }

  private fail(reason: RoomFailure) {
    if (this.closed) return
    this.closed = true
    this.stop()
    this.events.failed(reason)
  }
}
