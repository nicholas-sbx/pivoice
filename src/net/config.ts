const env = import.meta.env

/**
 * STUN first and pray: Google's and Cloudflare's public STUN. A TURN server
 * from the build goes first when configured, and the Worker's Cloudflare
 * TURN ahead of that (fetchIceServers).
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
  servers.push({ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] })
  return servers
}

function isIceServer(x: unknown): x is RTCIceServer {
  if (typeof x !== 'object' || x === null) return false
  const urls = (x as { urls?: unknown }).urls
  return typeof urls === 'string' || (Array.isArray(urls) && urls.every(u => typeof u === 'string'))
}

/**
 * Asks our own Worker (`/api/ice`) for short-lived Cloudflare TURN
 * credentials. Empty unless the Worker has TURN configured; that, or anything else
 * (dev server, no TURN key, slow network) falls back to the defaults.
 */
export async function fetchIceServers(timeoutMs = 2500): Promise<RTCIceServer[]> {
  const fallback = defaultIceServers()
  try {
    const res = await fetch(apiUrl('ice'), { signal: AbortSignal.timeout(timeoutMs) })
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

/** The Worker's API, next to the page. */
export function apiUrl(path: string): URL {
  return new URL('./api/' + path, location.href)
}

/** The WebSocket into a room (see worker/room.ts). */
export function roomSocketUrl(code: string): string {
  const url = apiUrl(`rooms/${code}/ws`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

/** Base for invite links. */
export function publicUrl(): string {
  const configured = env.VITE_PUBLIC_URL?.trim()
  if (configured) return configured.endsWith('/') ? configured : configured + '/'
  return location.origin + location.pathname
}
