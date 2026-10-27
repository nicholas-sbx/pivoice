import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOSE, MAX_MEMBERS, PROTOCOL_VERSION, memberIdFromKey, newMemberKey, type Member, type ServerMsg } from '../src/net/protocol'
import type { Env } from '../worker/env'
import { AWAY_GRACE_MS, Room } from '../worker/room'

/**
 * The room against a stand-in for the Durable Object runtime: hibernatable
 * sockets with attachments, storage, one alarm, and the auto-response
 * timestamps the keep-alive pings leave behind.
 */

class FakeSocket {
  sent: string[] = []
  closed: { code: number; reason: string } | null = null
  readyState = 1
  private att: unknown = null
  serializeAttachment(a: unknown) {
    this.att = structuredClone(a)
  }
  deserializeAttachment() {
    return structuredClone(this.att)
  }
  send(m: string) {
    if (this.closed) throw new Error('closed')
    this.sent.push(m)
  }
  close(code = 1000, reason = '') {
    this.closed ??= { code, reason }
    this.readyState = 3
  }
  msgs(): ServerMsg[] {
    return this.sent.map(m => JSON.parse(m) as ServerMsg)
  }
  last<T extends ServerMsg['t']>(t: T): Extract<ServerMsg, { t: T }> | undefined {
    return this.msgs()
      .filter((m): m is Extract<ServerMsg, { t: T }> => m.t === t)
      .at(-1)
  }
}

class FakeState {
  sockets: FakeSocket[] = []
  data = new Map<string, unknown>()
  alarmAt: number | null = null
  pings = new Map<FakeSocket, number>()
  storage = {
    get: async (k: string) => structuredClone(this.data.get(k)),
    put: async (k: string, v: unknown) => void this.data.set(k, structuredClone(v)),
    delete: async (k: string) => this.data.delete(k),
    deleteAll: async () => this.data.clear(),
    getAlarm: async () => this.alarmAt,
    setAlarm: async (t: number) => void (this.alarmAt = t),
    deleteAlarm: async () => void (this.alarmAt = null)
  }
  acceptWebSocket(ws: FakeSocket) {
    this.sockets.push(ws)
  }
  // The runtime forgets sockets once they've closed.
  getWebSockets() {
    return this.sockets.filter(s => s.readyState !== 3)
  }
  setWebSocketAutoResponse() {}
  getWebSocketAutoResponseTimestamp(ws: FakeSocket) {
    const t = this.pings.get(ws)
    return t === undefined ? null : new Date(t)
  }
}

let state: FakeState
let room: Room

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  vi.stubGlobal('WebSocketRequestResponsePair', class {})
  state = new FakeState()
  room = new Room(state as unknown as DurableObjectState, {} as Env)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** What Room.fetch does with an upgrade, minus the 101 response Node can't make. */
function connect(): FakeSocket {
  const ws = new FakeSocket()
  state.acceptWebSocket(ws)
  ws.serializeAttachment({ member: null, at: Date.now() })
  return ws
}

const say = (ws: FakeSocket, msg: unknown) => room.webSocketMessage(ws as unknown as WebSocket, typeof msg === 'string' ? msg : JSON.stringify(msg))
const hello = (key: string, extra: Record<string, unknown> = {}) => ({
  t: 'hello',
  v: PROTOCOL_VERSION,
  key,
  name: 'Ada',
  muted: false,
  deafened: false,
  ll: false,
  resume: null,
  ...extra
})

async function join(key = newMemberKey(), extra: Record<string, unknown> = {}): Promise<{ ws: FakeSocket; id: string; key: string }> {
  const ws = connect()
  await say(ws, hello(key, extra))
  return { ws, id: await memberIdFromKey(key), key }
}

const roster = (ws: FakeSocket): Member[] => ws.last('roster')?.members ?? []
const link = '0123456789abcdef'

describe('room', () => {
  it('turns people away from a room nobody made', async () => {
    const { ws } = await join()
    expect(ws.closed?.code).toBe(CLOSE.notFound)
    // And keeps nothing about it.
    expect(state.data.size).toBe(0)
    expect(state.alarmAt).toBeNull()
  })

  it('lets the maker in, once', async () => {
    expect(await room.reserve()).toBe(true)
    expect(await room.reserve()).toBe(false)
    const { ws, id } = await join()
    expect(ws.closed).toBeNull()
    expect(ws.last('welcome')).toEqual({ t: 'welcome', id })
    expect(roster(ws)).toEqual([{ id, name: 'Ada', joinedAt: Date.now(), muted: false, deafened: false, ll: false, away: false }])
    // Taken now: nobody else can claim the code.
    expect(await room.reserve()).toBe(false)
  })

  it('remakes a room for someone who was in it (a deploy restarts every room)', async () => {
    const { ws } = await join(newMemberKey(), { resume: 500 })
    expect(ws.closed).toBeNull()
    expect(roster(ws)[0].joinedAt).toBe(500)
  })

  it('passes signals on, saying who they are from', async () => {
    await room.reserve()
    const a = await join()
    const b = await join()
    expect(roster(a.ws).map(m => m.id)).toEqual([a.id, b.id])
    await say(a.ws, { t: 'signal', to: b.id, from: 'forged', signal: { kind: 'voice', link, sdp: { type: 'offer', sdp: 'v=0' } } })
    expect(b.ws.last('signal')).toEqual({ t: 'signal', from: a.id, signal: { kind: 'voice', link, sdp: { type: 'offer', sdp: 'v=0' } } })
    // To nobody in particular, or themselves: nothing.
    const before = a.ws.sent.length + b.ws.sent.length
    await say(a.ws, { t: 'signal', to: 'f'.repeat(32), signal: { kind: 'voice', link, bye: true } })
    await say(a.ws, { t: 'signal', to: a.id, signal: { kind: 'voice', link, bye: true } })
    expect(a.ws.sent.length + b.ws.sent.length).toBe(before)
    expect(a.ws.closed).toBeNull()
  })

  it('shares state changes', async () => {
    await room.reserve()
    const a = await join()
    const b = await join()
    await say(b.ws, { t: 'state', muted: true, deafened: false, ll: true })
    expect(roster(a.ws).find(m => m.id === b.id)).toMatchObject({ muted: true, ll: true })
  })

  it('wants a hello first, and well-formed messages always', async () => {
    await room.reserve()
    const ws = connect()
    await say(ws, { t: 'state', muted: true, deafened: false, ll: false })
    expect(ws.closed?.code).toBe(CLOSE.bad)
    const ws2 = connect()
    await say(ws2, '{not json')
    expect(ws2.closed?.code).toBe(CLOSE.bad)
    const ws3 = connect()
    await room.webSocketMessage(ws3 as unknown as WebSocket, new ArrayBuffer(8))
    expect(ws3.closed?.code).toBe(CLOSE.bad)
  })

  it('turns away old clients', async () => {
    await room.reserve()
    const { ws } = await join(newMemberKey(), { v: PROTOCOL_VERSION - 1 })
    expect(ws.closed?.code).toBe(CLOSE.version)
  })

  it('fills up', async () => {
    await room.reserve()
    for (let i = 0; i < MAX_MEMBERS; i++) expect((await join()).ws.closed).toBeNull()
    expect((await join()).ws.closed?.code).toBe(CLOSE.full)
  })

  it('swaps a second socket for the same member in, same seat', async () => {
    await room.reserve()
    const first = await join()
    vi.advanceTimersByTime(5_000)
    const other = await join()
    const second = await join(first.key)
    expect(first.ws.closed?.code).toBe(CLOSE.replaced)
    expect(second.id).toBe(first.id)
    expect(roster(other.ws).map(m => m.id)).toEqual([first.id, other.id])
  })

  it('keeps a seat for someone who drops, for a while', async () => {
    await room.reserve()
    const a = await join()
    const b = await join()
    const joinedAt = roster(a.ws)[1].joinedAt
    b.ws.close(1006)
    await room.webSocketClose(b.ws as unknown as WebSocket)
    expect(roster(a.ws).find(m => m.id === b.id)?.away).toBe(true)

    // Back in time: same place in line.
    vi.advanceTimersByTime(AWAY_GRACE_MS - 1000)
    const back = await join(b.key)
    expect(roster(a.ws).find(m => m.id === b.id)).toMatchObject({ away: false, joinedAt })

    // Gone too long: dropped.
    back.ws.close(1006)
    await room.webSocketClose(back.ws as unknown as WebSocket)
    vi.advanceTimersByTime(AWAY_GRACE_MS + 1)
    state.pings.set(a.ws, Date.now())
    await room.alarm()
    expect(roster(a.ws).map(m => m.id)).toEqual([a.id])
  })

  it('lets go of someone who says goodbye straight away', async () => {
    await room.reserve()
    const a = await join()
    const b = await join()
    await say(b.ws, { t: 'leave' })
    expect(b.ws.closed?.code).toBe(CLOSE.left)
    expect(roster(a.ws).map(m => m.id)).toEqual([a.id])
  })

  it('notices sockets that went quiet, and forgets the room once everyone has gone', async () => {
    await room.reserve()
    const a = await join()
    vi.advanceTimersByTime(35_000)
    await room.alarm()
    expect(a.ws.closed?.code).toBe(CLOSE.timeout)
    expect(state.data.get('away')).toHaveProperty(a.id)
    vi.advanceTimersByTime(AWAY_GRACE_MS + 1)
    await room.alarm()
    expect(state.data.size).toBe(0)
    expect(state.alarmAt).toBeNull()
  })

  it('keeps sockets that ping', async () => {
    await room.reserve()
    const a = await join()
    vi.advanceTimersByTime(35_000)
    state.pings.set(a.ws, Date.now() - 3_000)
    await room.alarm()
    expect(a.ws.closed).toBeNull()
    expect(state.alarmAt).toBeGreaterThan(Date.now())
  })

  it('closes sockets that never say hello', async () => {
    await room.reserve()
    const ws = connect()
    vi.advanceTimersByTime(11_000)
    await room.alarm()
    expect(ws.closed?.code).toBe(CLOSE.bad)
  })

  it('cuts off a flood', async () => {
    await room.reserve()
    const a = await join()
    const b = await join()
    for (let i = 0; i < 400 && !a.ws.closed; i++) await say(a.ws, { t: 'signal', to: b.id, signal: { kind: 'voice', link, bye: true } })
    expect(a.ws.closed?.code).toBe(CLOSE.slow)
  })
})
