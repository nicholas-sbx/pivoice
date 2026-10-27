import type { PeerOptions } from 'peerjs'

const env = import.meta.env

export interface PeerServerConfig {
  host: string
  port: number
  path: string
  secure: boolean
  key: string
}

/** Build-time broker override from .env; the PeerJS cloud broker otherwise. */
export function envPeerServer(): PeerServerConfig | null {
  const host = env.VITE_PEER_HOST?.trim()
  if (!host) return null
  return {
    host,
    port: Number(env.VITE_PEER_PORT) || 443,
    path: env.VITE_PEER_PATH || '/',
    secure: env.VITE_PEER_SECURE ? env.VITE_PEER_SECURE !== 'false' : true,
    key: env.VITE_PEER_KEY || 'peerjs'
  }
}

/**
 * STUN first and pray: Google's and Cloudflare's public STUN, plus PeerJS's
 * free best-effort relay as the last resort. A TURN server from the build
 * goes first when configured.
 */
export function defaultIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = []
  const turnUrls = env.VITE_TURN_URLS?.trim()
  if (turnUrls) {
    servers.push({
      urls: turnUrls
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
      username: env.VITE_TURN_USERNAME || undefined,
      credential: env.VITE_TURN_CREDENTIAL || undefined
    })
  }
  servers.push(
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
    {
      urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'],
      username: 'peerjs',
      credential: 'peerjsp'
    }
  )
  return servers
}

function isIceServer(x: unknown): x is RTCIceServer {
  if (typeof x !== 'object' || x === null) return false
  const urls = (x as { urls?: unknown }).urls
  return typeof urls === 'string' || (Array.isArray(urls) && urls.every(u => typeof u === 'string'))
}

/**
 * Asks our own Worker (`/api/ice`) for short-lived Cloudflare TURN
 * credentials. Only there when the Worker has TURN configured; anything else
 * (dev server, no TURN key, slow network) falls back to the defaults.
 */
export async function fetchIceServers(timeoutMs = 2500): Promise<RTCIceServer[]> {
  const fallback = defaultIceServers()
  try {
    const res = await fetch(new URL('./api/ice', location.href), { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return fallback
    const body = (await res.json()) as { iceServers?: unknown }
    const servers = Array.isArray(body.iceServers) ? body.iceServers.filter(isIceServer) : []
    if (!servers.length) return fallback
    // Ours first; the public ones stay as a backup.
    return [...servers, ...fallback]
  } catch {
    return fallback
  }
}

export function peerOptions(iceServers: RTCIceServer[]): PeerOptions {
  const opts: PeerOptions = { debug: 1, config: { iceServers } }
  const s = envPeerServer()
  if (s) {
    opts.host = s.host
    opts.port = s.port
    opts.path = s.path
    opts.secure = s.secure
    opts.key = s.key
  }
  return opts
}

/** Base for invite links. */
export function publicUrl(): string {
  const configured = env.VITE_PUBLIC_URL?.trim()
  if (configured) return configured.endsWith('/') ? configured : configured + '/'
  return location.origin + location.pathname
}
