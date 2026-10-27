/**
 * pivoice: the app's Worker.
 *
 * It serves the static build in dist/, adding the two headers that make the
 * page cross-origin isolated (which the low-latency engine needs for its
 * shared memory between audio thread and worker), and one endpoint of its
 * own:
 *
 *   GET /api/ice  →  { iceServers: RTCIceServer[] }
 *
 * which mints short-lived Cloudflare TURN credentials, so calls still connect
 * when STUN can't get through a NAT. It's optional: without TURN_KEY_ID and
 * TURN_KEY_API_TOKEN set (as secrets) it answers 404 and the app uses public
 * STUN and PeerJS's best-effort relay instead. Nothing else here talks to
 * the network; the calls themselves are peer to peer.
 */

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
  /** Cloudflare Realtime TURN key id (dashboard → Realtime → TURN). */
  TURN_KEY_ID?: string
  /** That key's API token. */
  TURN_KEY_API_TOKEN?: string
  /** Credential lifetime in seconds (default 4 h; a call longer than that keeps its relay). */
  TURN_TTL_S?: string
  /** Comma-separated extra origins allowed to ask for credentials (the app's own origin always is). */
  ALLOWED_ORIGINS?: string
  RATE_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> }
}

const TURN_API = 'https://rtc.live.cloudflare.com/v1/turn/keys'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/ice') return ice(request, env, url)
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404)
    return isolate(await env.ASSETS.fetch(request))
  }
}

/**
 * Cross-origin isolation: SharedArrayBuffer only exists in pages served
 * with these. Everything the app loads is its own origin; the broker and
 * the calls are WebSocket and WebRTC, which these don't affect.
 */
export const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp'
} as const

function isolate(res: Response): Response {
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries(ISOLATION_HEADERS)) out.headers.set(k, v)
  return out
}

async function ice(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405)
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return json({ error: 'TURN is not configured' }, 404)

  // Only our own pages (and any listed origins) get relay credentials: they
  // cost money per GB, so they're not for anyone who finds the URL. Browsers
  // send Origin on fetch() from another origin and Sec-Fetch-Site always.
  const origin = request.headers.get('Origin')
  const site = request.headers.get('Sec-Fetch-Site')
  const allowed = new Set([url.origin, ...(env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean)])
  if (origin ? !allowed.has(origin) : site !== null && site !== 'same-origin') {
    return json({ error: 'Origin not allowed' }, 403)
  }

  if (env.RATE_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    const { success } = await env.RATE_LIMITER.limit({ key: ip })
    if (!success) return json({ error: 'Slow down' }, 429, { 'Retry-After': '60' })
  }

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
