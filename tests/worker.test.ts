import { afterEach, describe, expect, it, vi } from 'vitest'
import { isRoomCode } from '../src/lib/roomCode'
import worker, { normaliseIceServers, type Env } from '../worker/index'

const assets = { fetch: async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }) }

/** Stands in for the rooms: remembers which codes it was asked about, and which of those are taken. */
function rooms(taken: (code: string) => boolean = () => false) {
  const asked: string[] = []
  const joined: string[] = []
  const ns = {
    getByName: (code: string) => ({
      reserve: async () => {
        asked.push(code)
        return !taken(code)
      },
      fetch: async () => {
        joined.push(code)
        return new Response('upgraded')
      }
    })
  }
  return { ns: ns as unknown as Env['ROOMS'], asked, joined }
}

const env = (extra: Partial<Env> = {}): Env => ({ ASSETS: assets, ROOMS: rooms().ns, ...extra })
const get = (path: string, headers: Record<string, string> = {}) => new Request('https://pivoice.example' + path, { headers })
const post = (path: string, headers: Record<string, string> = {}) => new Request('https://pivoice.example' + path, { method: 'POST', headers })
const SAME = { Origin: 'https://pivoice.example' }
const UPGRADE = { Upgrade: 'websocket' }

afterEach(() => vi.unstubAllGlobals())

describe('worker', () => {
  it('hands anything else to the static assets', async () => {
    const res = await worker.fetch(get('/'), env())
    expect(await res.text()).toBe('<!doctype html>')
    expect(res.headers.get('content-type')).toBe('text/html')
  })

  it('answers /api/ice with no servers without TURN configured', async () => {
    const res = await worker.fetch(get('/api/ice'), env())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ iceServers: [] })
  })

  it('mints credentials for our own pages', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({
        iceServers: [
          { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
          { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' }
        ]
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    const res = await worker.fetch(get('/api/ice', { 'Sec-Fetch-Site': 'same-origin' }), env({ TURN_KEY_ID: 'kid', TURN_KEY_API_TOKEN: 'tok' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { iceServers: { urls: string[] }[] }
    expect(body.iceServers[0].urls).toEqual(['stun:stun.cloudflare.com:3478'])
    expect(body.iceServers[1]).toMatchObject({ username: 'u', credential: 'c' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/kid/credentials/generate-ice-servers')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body as string)).toEqual({ ttl: 4 * 3600 })
  })

  it('refuses other sites', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ iceServers: [{ urls: ['turn:x:3478'] }] })))
    const e = env({ TURN_KEY_ID: 'kid', TURN_KEY_API_TOKEN: 'tok' })
    expect((await worker.fetch(get('/api/ice', { Origin: 'https://evil.example' }), e)).status).toBe(403)
    expect((await worker.fetch(get('/api/ice', { 'Sec-Fetch-Site': 'cross-site' }), e)).status).toBe(403)
    expect((await worker.fetch(get('/api/ice', { Origin: 'https://pivoice.example' }), e)).status).not.toBe(403)
  })

  it('makes rooms with a code the room agreed to', async () => {
    const r = rooms(code => r.asked.length === 1 && !!code)
    const res = await worker.fetch(post('/api/rooms', SAME), env({ ROOMS: r.ns }))
    expect(res.status).toBe(201)
    const { code } = (await res.json()) as { code: string }
    expect(isRoomCode(code)).toBe(true)
    // The first one it tried was taken.
    expect(r.asked).toHaveLength(2)
    expect(r.asked[1]).toBe(code)
  })

  it('gives up after a few taken codes', async () => {
    const r = rooms(() => true)
    expect((await worker.fetch(post('/api/rooms', SAME), env({ ROOMS: r.ns }))).status).toBe(503)
    expect(r.asked).toHaveLength(5)
  })

  it('only makes rooms for our own pages, by POST', async () => {
    expect((await worker.fetch(post('/api/rooms', { Origin: 'https://evil.example' }), env())).status).toBe(403)
    expect((await worker.fetch(get('/api/rooms', SAME), env())).status).toBe(405)
  })

  it('hands WebSockets from our own pages to the room', async () => {
    const r = rooms()
    const e = env({ ROOMS: r.ns })
    expect(await (await worker.fetch(get('/api/rooms/ABC234/ws', { ...SAME, ...UPGRADE }), e)).text()).toBe('upgraded')
    expect(r.joined).toEqual(['ABC234'])
    // Another site, no Origin at all, not a WebSocket, not a code: never reaches a room.
    expect((await worker.fetch(get('/api/rooms/ABC234/ws', { Origin: 'https://evil.example', ...UPGRADE }), e)).status).toBe(403)
    expect((await worker.fetch(get('/api/rooms/ABC234/ws', UPGRADE), e)).status).toBe(403)
    expect((await worker.fetch(get('/api/rooms/ABC234/ws', SAME), e)).status).toBe(426)
    expect((await worker.fetch(get('/api/rooms/ABC0S1/ws', { ...SAME, ...UPGRADE }), e)).status).toBe(404)
    expect(r.joined).toEqual(['ABC234'])
  })

  it('rate limits rooms per IP when the limiter is bound', async () => {
    const keys: string[] = []
    const ROOM_LIMITER = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) }
    const res = await worker.fetch(post('/api/rooms', { ...SAME, 'CF-Connecting-IP': '203.0.113.7' }), env({ ROOM_LIMITER }))
    expect(res.status).toBe(429)
    expect(keys).toEqual(['room:203.0.113.7'])
  })

  it('normalises the older single-object answer', () => {
    expect(normaliseIceServers({ urls: 'turn:x:3478', username: 'a', credential: 'b' })).toEqual([
      { urls: ['turn:x:3478'], username: 'a', credential: 'b' }
    ])
    expect(normaliseIceServers(null)).toEqual([])
  })
})
