import type { LLConfig } from '../audio/ll/config'
import type { SpatialMode } from '../audio/engine'
import type { IceCandidate, LinkKind, SessionDescription } from '../net/protocol'
import type { LinkStats } from '../net/stats'

/**
 * What the page and the app (native/, the Go binary) say to each other
 * over the bridge. Must match native/internal/proto/proto.go.
 *
 * In the app, the page is only the UI: it keeps the room's WebSocket and
 * the call's logic (who calls whom, retries; see net/session.ts), and the
 * app does everything with audio in it: the sound card, the WebRTC
 * connections, encoding, decoding, mixing. Signalling goes through the
 * page: the app's offers, answers and candidates out to the room, the
 * room's in to the app.
 */

/** Bump with native/internal/proto.Protocol when the two stop understanding each other. */
export const NATIVE_PROTOCOL = 1

export interface AppConfig {
  ll: LLConfig
  spatial: SpatialMode
  dtx: boolean
  inputId: string
  outputId: string
}

/** One of our signals' bodies, as the app sends it: the page adds `kind` and `link` for the room. */
export type AppSignal = { sdp: SessionDescription } | { ice: IceCandidate }

export type ToApp =
  | { t: 'hello'; token: string; site: string; protocol: number }
  | { t: 'config'; config: AppConfig }
  | { t: 'self'; muted: boolean; deafened: boolean }
  | { t: 'members'; members: { id: string; deafened: boolean }[] }
  | { t: 'peer'; id: string; volume?: number; silenced?: boolean; angle?: number }
  | { t: 'link'; op: 'open'; link: string; peer: string; kind: LinkKind; offerer: boolean; iceServers: RTCIceServer[] }
  | { t: 'link'; op: 'signal'; link: string; signal: AppSignal }
  | { t: 'link'; op: 'close'; link: string }
  | { t: 'audio'; on: boolean }
  | { t: 'test'; path: '' | 'raw' | 'll' }
  | { t: 'stats' }
  | { t: 'devices' }
  /** A link for the system's browser (the window opens none itself). Works on any protocol. */
  | { t: 'open'; url: string }

export interface AppInfo {
  version: string
  protocol: number
  os: string
  arch: string
}

/** The sound card, as the app has it open. */
export interface AudioInfo {
  input: string
  output: string
  api: string
  inputLatencyMs: number
  outputLatencyMs: number
  /** Samples per callback. */
  block: number
}

export interface AppDevice {
  id: string
  name: string
  input: boolean
  output: boolean
  default: boolean
}

export interface AppStats {
  peers: Record<string, LinkStats>
  test: { ms: number | null; measured: boolean; detail: string } | null
  audio: AudioInfo | null
}

export type FromApp =
  | ({ t: 'hello' } & AppInfo)
  | { t: 'signal'; link: string; signal: AppSignal }
  | { t: 'link'; link: string; state: 'connected' | 'closed' | 'll-up' | 'll-down' }
  | { t: 'levels'; self: number; remotes: Record<string, number> }
  | { t: 'audio'; on: boolean; error?: string; micProblem?: 'missing'; info?: AudioInfo }
  | ({ t: 'stats' } & AppStats)
  | { t: 'devices'; devices: AppDevice[] | null }

// ---- versions ------------------------------------------------------------------

/**
 * Whether this page can work with this app, and if not, which of the two
 * is behind. The protocol decides: the app and the site are released
 * separately, so either can be the older one.
 *
 *  - app older: download the new app;
 *  - app newer: this page is the old one (cached, or the site's release
 *    hasn't gone out yet), so restarting the app loads the current site;
 *  - same protocol, but a newer app is out: say so, and carry on.
 */
export type Verdict =
  | { ok: true; newer: string | null }
  | { ok: false; action: 'download'; latest: string }
  | { ok: false; action: 'restart' }

export function judge(app: Pick<AppInfo, 'version' | 'protocol'>, latest: string, protocol = NATIVE_PROTOCOL): Verdict {
  if (app.protocol < protocol) return { ok: false, action: 'download', latest }
  if (app.protocol > protocol) return { ok: false, action: 'restart' }
  return { ok: true, newer: compareVersions(app.version, latest) < 0 ? latest : null }
}

/** Semver-ish: numbers compared part by part, so 0.10.0 is after 0.9.1. Anything unparseable sorts first. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, '').split(/[.+-]/).slice(0, 3).map(n => (/^\d+$/.test(n) ? Number(n) : -1))
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return Math.sign(d)
  }
  return 0
}
