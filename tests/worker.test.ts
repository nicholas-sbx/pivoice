import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { normaliseIceServers, type Env } from '../worker/index'

const assets = { fetch: async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }) }
const env = (extra: Partial<Env> = {}): Env => ({ ASSETS: assets, ...extra })
const get = (path: string, headers: Record<string, string> = {}) => new Request('https://pivoice.example' + path, { headers })

afterEach(() => vi.unstubAllGlobals())

describe('worker', () => {
  it('hands everything else to the static assets, cross-origin isolated', async () => {
    const res = await worker.fetch(get('/'), env())
    expect(await res.text()).toBe('<!doctype html>')
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin')
    expect(res.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp')
    expect(res.headers.get('content-type')).toBe('text/html')
  })

  it('says 404 for /api/ice without TURN configured', async () => {
    const res = await worker.fetch(get('/api/ice'), env())
    expect(res.status).toBe(404)
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

  it('normalises the older single-object answer', () => {
    expect(normaliseIceServers({ urls: 'turn:x:3478', username: 'a', credential: 'b' })).toEqual([
      { urls: ['turn:x:3478'], username: 'a', credential: 'b' }
    ])
    expect(normaliseIceServers(null)).toEqual([])
  })
})
