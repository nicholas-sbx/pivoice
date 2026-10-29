import type { LLConfig } from '../audio/ll/config'
import type { SpatialMode } from '../audio/engine'
import type { Placed } from '../lib/seats'
import type { IceCandidate, LinkKind, Member, SessionDescription } from '../net/protocol'
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
  /** Windows: WASAPI exclusive mode. */
  exclusive: boolean
  processing: ProcessingConfig
}

/** What the app does to your mic before it goes out (all off: nothing at all, at no cost). */
export interface ProcessingConfig {
  echo: boolean
  noise: boolean
  gain: boolean
  /** Noise suppression's voice gate: 0 is off, up to 1. */
  gateThreshold: number
  gateGraceMs: number
  /** RNNoise's own lookahead: 10 ms more delay, for cleaner starts of words. */
  noiseLookahead: boolean
  /** Automatic gain: the level it aims for (dBFS RMS), the most it may boost (dB), the loudest it lets peaks be (dBFS), how fast it turns up and down (ms). */
  gainTargetDb: number
  gainMaxDb: number
  gainCeilingDb: number
  gainRiseMs: number
  gainFallMs: number
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
  /** The overlay (only to an app whose hello says `overlay`): show it there, take it down, or what to draw. */
  | { t: 'overlay'; op: 'show'; place: OverlayPlace }
  | { t: 'overlay'; op: 'hide' }
  | { t: 'overlay'; op: 'state'; state: OverlayState }
  | { t: 'overlay'; op: 'look'; look: OverlayLook }
  | { t: 'monitors' }

/** Which side of the screen the overlay keeps to: a corner, the middle of an edge, or the very middle. */
export type OverlayAnchor = 'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right'

/**
 * Where the overlay goes. Kept as a side of a screen and a distance from it,
 * not a position, so it stays in its corner whatever happens to the screen
 * (another resolution, a panel moved, the screens rearranged), and it's the
 * same thing a Wayland compositor is asked for. Distances are in the screen's
 * own (scaled) pixels, and measured from the area windows can use, so it
 * never sits under a taskbar or panel.
 */
export interface OverlayPlace {
  /** One of the app's `monitors`, or '' for whichever has the Pivoice window on it. */
  monitor: string
  anchor: OverlayAnchor
  margin: number
  /** Its width and height. */
  size: number
}

export interface OverlayLook {
  /** How visible the table and anyone quiet are, 0–1; whoever's speaking is always in full. */
  opacity: number
  /** How big the faces and names are (1: as they'd be at this size). */
  scale: number
  /** Being placed: show its edges. */
  placing: boolean
}

/** What the overlay draws, from the call: a snapshot, sent whenever it changes. */
export interface OverlayState {
  selfId: string
  members: Member[]
  /** Where everyone else is heading on the page's table (lib/seats `targets`). */
  seats: Placed[]
  selfMuted: boolean
  selfDeafened: boolean
  silenced: Record<string, boolean>
}

/** What the app tells the overlay's own page (src/overlay). */
export type ToOverlay =
  | { t: 'state'; state: OverlayState }
  | { t: 'look'; look: OverlayLook }
  /** Who's speaking and who's making any sound at all, as the app hears it, whenever that changes. You're ''. */
  | { t: 'rings'; speaking: string[]; audible: string[] }

export interface AppMonitor {
  id: string
  name: string
  /** Its usable area's size, in its own (scaled) pixels. */
  width: number
  height: number
  primary: boolean
  /** The Pivoice window is on it. */
  current: boolean
}

export interface AppInfo {
  version: string
  protocol: number
  os: string
  arch: string
  /** Whether this build has noise suppression (RNNoise). */
  noise?: boolean
  /** Whether it can show the overlay here (a window, on a desktop it knows how to put one on). */
  overlay?: boolean
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
  /** Windows: how WASAPI was opened (exclusive, raw, shared). */
  mode?: string
}

/** Everything on the app's side that can put a click in the audio, since the sound card opened. */
export interface Glitches {
  /** The mic's buffer filled before the app read it. */
  inputOverflows: number
  /** The speakers ran dry: a block was late. */
  outputUnderflows: number
  /** Mic blocks lost because the sender fell behind. */
  captureDropped: number
  /** Incoming audio thrown away because the audio thread fell behind. */
  framesDropped: number
  /** The longest the app's garbage collector stopped everything, lately. */
  gcPauseMaxMs: number
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
  glitches?: Glitches
}

export type FromApp =
  | ({ t: 'hello' } & AppInfo)
  | { t: 'signal'; link: string; signal: AppSignal }
  | { t: 'link'; link: string; state: 'connected' | 'closed' | 'll-up' | 'll-down' }
  | { t: 'levels'; self: number; remotes: Record<string, number> }
  | { t: 'audio'; on: boolean; error?: string; micProblem?: 'missing'; info?: AudioInfo }
  | ({ t: 'stats' } & AppStats)
  | { t: 'devices'; devices: AppDevice[] | null }
  /**
   * The screens the overlay can go on. `placeable`: it goes where it's told
   * (not on GNOME, which places windows itself). `onTop`: it stays above
   * other windows (not on GNOME either, which only lets you ask for that
   * yourself, from the window's menu).
   */
  | { t: 'monitors'; monitors: AppMonitor[]; placeable: boolean; onTop: boolean }
  | { t: 'overlay'; on: boolean; error?: string }

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
