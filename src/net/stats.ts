import type { LLRemoteStats } from '../audio/ll/engine'

/**
 * What the link to one person looks like: ping, the route their audio takes
 * (same network, straight through the NATs, or bounced off a TURN relay),
 * and what our end does with it (the low-latency engine's jitter buffer,
 * loss, bitrate). The route comes from the peer connection's stats
 * (routeOf); the rest from the engine.
 */

export type RouteKind = 'local' | 'direct' | 'relay'

export interface RouteStats {
  /** Round trip on the network path, ms. */
  rttMs: number | null
  route: RouteKind | null
  /** Transport between the two ends of the pair: udp or tcp. */
  protocol: string | null
  /** How we reach our TURN server, when we're the one relaying. */
  relayProtocol: string | null
  /** Our TURN server's host name, when we're the one relaying. */
  relayHost: string | null
  /** host / srflx / prflx / relay. */
  localType: string | null
  remoteType: string | null
}

export interface LinkStats extends RouteStats {
  jitterMs: number | null
  /** Audio concealed (lost or late) since the last sample, %. */
  lossPct: number | null
  /** How long incoming audio sits in the jitter buffer, ms. */
  bufferMs: number | null
  /** Incoming audio bitrate, kbit/s. */
  kbps: number | null
  /** From the jitter buffer to your speakers: the audio output path, sound card included. */
  playoutMs: number | null
  /** Microphone to us, as the browser reports it for *your* mic (we can't see theirs). */
  captureMs: number | null
  /** Filling one 128-sample block before it goes out. */
  sendMs: number
  /**
   * Mouth to ear, best estimate: capture + send + half the round trip +
   * jitter buffer + playout. Stages that aren't reported count as 0, so
   * it's a floor rather than a measurement.
   */
  mouthToEarMs: number | null
  /** Mouth to ear as actually measured from capture timestamps (exact on one machine), ms. */
  measuredMs: number | null
  /** The low-latency engine's own receive-side numbers. */
  ll: LLRemoteStats | null
}

type Stat = Record<string, unknown> & { type?: unknown; id?: unknown }

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null)

/** The route and ping, from a peer connection's stats report (anything iterable of stats objects). */
export function routeOf(report: Iterable<Stat>): RouteStats {
  const byId = new Map<string, Stat>()
  const all: Stat[] = []
  for (const s of report) {
    all.push(s)
    if (typeof s.id === 'string') byId.set(s.id, s)
  }

  // The pair actually in use: the transport says which (Chrome), or the
  // pair says it's selected (Firefox), or the nominated, working one.
  let pair: Stat | undefined
  for (const s of all) {
    if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') {
      pair = byId.get(s.selectedCandidatePairId)
      if (pair) break
    }
  }
  pair ??= all.find(s => s.type === 'candidate-pair' && s.selected === true)
  pair ??= all.find(s => s.type === 'candidate-pair' && s.nominated === true && s.state === 'succeeded')

  const local = pair && typeof pair.localCandidateId === 'string' ? byId.get(pair.localCandidateId) : undefined
  const remote = pair && typeof pair.remoteCandidateId === 'string' ? byId.get(pair.remoteCandidateId) : undefined
  const localType = str(local?.candidateType)
  const remoteType = str(remote?.candidateType)
  const rtt = num(pair?.currentRoundTripTime)

  let route: RouteKind | null = null
  if (localType || remoteType) {
    if (localType === 'relay' || remoteType === 'relay') route = 'relay'
    else if (localType === 'host' && remoteType === 'host') route = 'local'
    else route = 'direct'
  }

  return {
    // Firefox doesn't fill it in; the engine's own pings stand in.
    rttMs: rtt === null ? null : rtt * 1000,
    route,
    protocol: str(local?.protocol) ?? str(pair?.protocol),
    relayProtocol: localType === 'relay' ? str(local?.relayProtocol) : null,
    relayHost: localType === 'relay' ? hostOf(str(local?.url)) : null,
    localType,
    remoteType
  }
}

/** `turn:turn.example.com:3478?transport=udp` → `turn.example.com`. */
export function hostOf(url: string | null): string | null {
  if (!url) return null
  const m = /^(?:stun|turns?):(?:\[([^\]]+)\]|([^?:]+))/i.exec(url)
  return m ? (m[1] ?? m[2]) : null
}

export function routeLabel(s: RouteStats): string {
  switch (s.route) {
    case 'local':
      return 'Same network'
    case 'direct':
      return 'Direct, peer to peer'
    case 'relay':
      return s.localType === 'relay' ? `Relayed via ${s.relayHost ?? 'TURN'}` : 'Relayed via their TURN'
    default:
      return 'Connecting…'
  }
}

/** Discord's colours for a connection: good, okay, bad. */
export function pingLevel(ms: number): 'good' | 'ok' | 'bad' {
  return ms < 80 ? 'good' : ms < 160 ? 'ok' : 'bad'
}
