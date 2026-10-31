import { generateRoomCode, isRoomCode } from '../src/lib/roomCode'
import type { Env } from './env'

/**
 * pivoice: the app's Worker.
 *
 * The static build in dist/ is served by Workers static assets without
 * running this code (wrangler.toml's run_worker_first), with the two headers
 * that make the page cross-origin isolated coming from public/_headers (the
 * low-latency engine needs them for shared memory between audio thread and
 * worker). This Worker is just a small API:
 *
 *   POST /api/rooms           →  { code }   a new room, its code held for a minute
 *   GET  /api/rooms/CODE/ws   →  WebSocket  into that room (a Durable Object, see room.ts)
 *   GET  /api/ice             →  { iceServers: RTCIceServer[] }  (empty without TURN)
 *
 * The rooms keep the roster and pass WebRTC signalling between members; the
 * audio itself is peer to peer and never comes through here. /api/ice mints
 * short-lived Cloudflare TURN credentials, so calls still connect when STUN
 * can't get through a NAT. It's optional: without TURN_KEY_ID and
 * TURN_KEY_API_TOKEN set (as secrets) it answers with no servers and the app
 * uses public STUN only.
 */

export { Room } from './room'
export type { Env } from './env'

const TURN_API = 'https://rtc.live.cloudflare.com/v1/turn/keys'
const ROOM_WS = /^\/api\/rooms\/([A-Z0-9]+)\/ws$/

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/ice') return ice(request, env, url)
    if (url.pathname === '/api/rooms') return createRoom(request, env, url)
    const ws = ROOM_WS.exec(url.pathname)
    if (ws) return joinRoom(request, env, url, ws[1])
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404)
    return env.ASSETS.fetch(request)
  }
}

async function ice(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405)
  // Not an error: STUN alone is a fine way to run, and a 404 would show up in every console.
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return json({ iceServers: [] }, 200)

  // Relay credentials cost money per GB, so they're not for anyone who finds the URL.
  const refused = refuseOthers(request, env, url) ?? (await limit(env.RATE_LIMITER, request, 'ice'))
  if (refused) return refused

  const ttl = clampInt(env.TURN_TTL_S, 300, 48 * 3600, 4 * 3600)
  let upstream: Response
  try {
    upstream = await fetch(`${TURN_API}/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl })
    })
  } catch {
    return json({ error: 'TURN service unreachable' }, 502)
  }
  if (!upstream.ok) return json({ error: `TURN service said ${upstream.status}` }, 502)
  const body = (await upstream.json()) as { iceServers?: unknown }
  const iceServers = normaliseIceServers(body.iceServers)
  if (!iceServers.length) return json({ error: 'TURN service returned nothing usable' }, 502)
  return json({ iceServers }, 200, { 'Cache-Control': 'no-store' })
}

/** Makes a room: picks an unused code and holds it for whoever asked. */
async function createRoom(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const refused = refuseOthers(request, env, url) ?? (await limit(env.ROOM_LIMITER, request, 'room'))
  if (refused) return refused
  // Codes are random over ~594 million, so a clash is rare; a few tries is plenty.
  for (let i = 0; i < 5; i++) {
    const code = generateRoomCode()
    if (await env.ROOMS.getByName(code).reserve()) return json({ code }, 201, { 'Cache-Control': 'no-store' })
  }
  return json({ error: 'No free room code' }, 503)
}

async function joinRoom(request: Request, env: Env, url: URL, code: string): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405)
  if (!isRoomCode(code)) return json({ error: 'Not found' }, 404)
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'Expected a WebSocket' }, 426)
  // Browsers always send Origin on a WebSocket, and a page elsewhere must not get to drive one of ours.
  const refused = refuseOthers(request, env, url, true) ?? (await limit(env.ROOM_LIMITER, request, 'room'))
  if (refused) return refused
  return env.ROOMS.getByName(code).fetch(request)
}

/**
 * Only our own pages (and any listed origins) may use the API. Browsers send
 * Origin on fetch() from another origin, on every POST and on every
 * WebSocket, and Sec-Fetch-Site always. That stops other sites using a
 * visitor's browser, not a determined script, which is what the rate
 * limiters and the rooms' own limits are for.
 */
function refuseOthers(request: Request, env: Env, url: URL, needOrigin = false): Response | null {
  const origin = request.headers.get('Origin')
  const site = request.headers.get('Sec-Fetch-Site')
  const allowed = new Set([url.origin, ...(env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean)])
  const ok = origin ? allowed.has(origin) : !needOrigin && (site === null || site === 'same-origin')
  return ok ? null : json({ error: 'Origin not allowed' }, 403)
}

async function limit(limiter: Env['RATE_LIMITER'], request: Request, what: string): Promise<Response | null> {
  if (!limiter) return null
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const { success } = await limiter.limit({ key: `${what}:${ip}` })
  return success ? null : json({ error: 'Slow down' }, 429, { 'Retry-After': '60' })
}

interface IceServer {
  urls: string[]
  username?: string
  credential?: string
}

/**
 * Cloudflare answers with a list of servers (or, from the older endpoint, a
 * single object). Port 53 is dropped: browsers block it and every candidate
 * on it just times out.
 */
export function normaliseIceServers(raw: unknown): IceServer[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : []
  const out: IceServer[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as { urls?: unknown; username?: unknown; credential?: unknown }
    const urls = (Array.isArray(e.urls) ? e.urls : [e.urls]).filter(
      (u): u is string => typeof u === 'string' && /^(stun|turns?):/.test(u) && !/:53(\?|$)/.test(u)
    )
    if (!urls.length) continue
    const server: IceServer = { urls }
    if (typeof e.username === 'string') server.username = e.username
    if (typeof e.credential === 'string') server.credential = e.credential
    out.push(server)
  }
  return out
}

function clampInt(raw: string | null | undefined, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }
  })
}
