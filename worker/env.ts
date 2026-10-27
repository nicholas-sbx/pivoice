import type { Room } from './room'

export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>
}

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
  /** One Durable Object per room code (see room.ts). */
  ROOMS: DurableObjectNamespace<Room>
  /** Cloudflare Realtime TURN key id (dashboard → Realtime → TURN). */
  TURN_KEY_ID?: string
  /** That key's API token. */
  TURN_KEY_API_TOKEN?: string
  /** Credential lifetime in seconds (default 4 h; a call longer than that keeps its relay). */
  TURN_TTL_S?: string
  /** Comma-separated extra origins allowed to use the API (the app's own origin always is). */
  ALLOWED_ORIGINS?: string
  /** Optional: caps how often one IP can ask for TURN credentials. */
  RATE_LIMITER?: RateLimiter
  /** Optional: caps how often one IP can make or connect to rooms. */
  ROOM_LIMITER?: RateLimiter
}
