import type { LLRemoteStats } from '../audio/ll/engine'
import { OPUS_LOOKAHEAD_MS, PTIME_MS } from './sdp'

/**
 * What one call's RTCPeerConnection stats say about the link to that person:
 * ping, the route the audio is taking (same network, straight through the
 * NATs, or bounced off a TURN relay), and what the receiving side is doing
 * to it (jitter buffer, loss, bitrate).
 *
 * Pure: takes the stats report (anything iterable of stats objects) and the
 * snapshot from last time, so rates come from the change since then rather
 * than averages over the whole call.
 */

export type RouteKind = 'local' | 'direct' | 'relay'

export interface LinkStats {
  /** Round trip on the network path the audio uses, ms. */
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
  jitterMs: number | null
  /** Audio packets lost since the last sample, %. */
  lossPct: number | null
  /** How long incoming audio sits in the jitter buffer, ms (since the last sample). */
  bufferMs: number | null
  /** Incoming audio bitrate, kbit/s. */
  kbps: number | null
  codec: string | null
  /** From the jitter buffer to your speakers: the browser's playout path, sound card included (Chrome reports it). */
  playoutMs: number | null
  /** Microphone to the encoder, as the browser reports it for *your* mic (we can't see theirs). */
  captureMs: number | null
  /** One Opus frame plus its lookahead. */
  codecMs: number
  /**
   * Mouth to ear, best estimate: capture + codec + half the round trip +
   * jitter buffer + playout. Stages the browser doesn't report count as 0,
   * so it's a floor rather than a measurement.
   */
  mouthToEarMs: number | null
  /** Which engine is carrying their voice to you. */
  engine: 'webrtc' | 'll'
  /** Mouth to ear as actually measured from capture timestamps (exact on one machine), ms. */
  measuredMs: number | null
  /** The low-latency engine's own receive-side numbers, when it's the one in use. */
  ll: LLRemoteStats | null
}

export interface Snapshot {
  at: number
  bytes: number
  lost: number
  received: number
  bufferDelay: number
  bufferEmitted: number
  playoutDelay: number
  playoutSamples: number
}

type Stat = Record<string, unknown> & { type?: unknown; id?: unknown }

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null)

export function summarise(
  report: Iterable<Stat>,
  prev?: Snapshot | null,
  opts: { captureMs?: number | null } = {}
): { stats: LinkStats; snapshot: Snapshot | null } {
  const byId = new Map<string, Stat>()
  const all: Stat[] = []
  for (const s of report) {
    all.push(s)
    if (typeof s.id === 'string') byId.set(s.id, s)
  }

  // The pair actually carrying the audio: the transport says which (Chrome),
  // or the pair says it's selected (Firefox), or the nominated, working one.
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

  let rttMs = num(pair?.currentRoundTripTime)
  if (rttMs === null) {
    // Firefox doesn't fill currentRoundTripTime in; RTCP's view of it is the next best.
    const rr = all.find(s => s.type === 'remote-inbound-rtp' && s.kind === 'audio')
    rttMs = num(rr?.roundTripTime)
  }
  if (rttMs !== null) rttMs *= 1000

  let route: RouteKind | null = null
  if (localType || remoteType) {
    if (localType === 'relay' || remoteType === 'relay') route = 'relay'
    else if (localType === 'host' && remoteType === 'host') route = 'local'
    else route = 'direct'
  }

  const inbound = all.find(s => s.type === 'inbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio'))
  const codecStat = inbound && typeof inbound.codecId === 'string' ? byId.get(inbound.codecId) : undefined
  const mime = str(codecStat?.mimeType)
  const playout =
    (inbound && typeof inbound.playoutId === 'string' ? byId.get(inbound.playoutId) : undefined) ??
    all.find(s => s.type === 'media-playout' && s.kind === 'audio')

  let snapshot: Snapshot | null = null
  let lossPct: number | null = null
  let bufferMs: number | null = null
  let kbps: number | null = null
  let playoutMs: number | null = null
  const jitter = num(inbound?.jitter)
  if (inbound) {
    snapshot = {
      at: num(inbound.timestamp) ?? Date.now(),
      bytes: num(inbound.bytesReceived) ?? 0,
      lost: Math.max(0, num(inbound.packetsLost) ?? 0),
      received: num(inbound.packetsReceived) ?? 0,
      bufferDelay: num(inbound.jitterBufferDelay) ?? 0,
      bufferEmitted: num(inbound.jitterBufferEmittedCount) ?? 0,
      playoutDelay: num(playout?.totalPlayoutDelay) ?? 0,
      playoutSamples: num(playout?.totalSamplesCount) ?? 0
    }
    const base: Snapshot =
      prev && prev.at < snapshot.at
        ? prev
        : { at: 0, bytes: 0, lost: 0, received: 0, bufferDelay: 0, bufferEmitted: 0, playoutDelay: 0, playoutSamples: 0 }
    const packets = snapshot.lost - base.lost + (snapshot.received - base.received)
    if (packets > 0) lossPct = (Math.max(0, snapshot.lost - base.lost) / packets) * 100
    const emitted = snapshot.bufferEmitted - base.bufferEmitted
    if (emitted > 0) bufferMs = ((snapshot.bufferDelay - base.bufferDelay) / emitted) * 1000
    const played = snapshot.playoutSamples - base.playoutSamples
    if (played > 0) playoutMs = ((snapshot.playoutDelay - base.playoutDelay) / played) * 1000
    if (base.at > 0) {
      const seconds = (snapshot.at - base.at) / 1000
      if (seconds > 0) kbps = ((snapshot.bytes - base.bytes) * 8) / 1000 / seconds
    }
  }

  const captureMs = opts.captureMs ?? null
  const codecMs = PTIME_MS + OPUS_LOOKAHEAD_MS
  const mouthToEarMs =
    rttMs !== null && bufferMs !== null ? (captureMs ?? 0) + codecMs + rttMs / 2 + bufferMs + (playoutMs ?? 0) : null

  return {
    stats: {
      rttMs,
      route,
      protocol: str(local?.protocol) ?? str(pair?.protocol),
      relayProtocol: localType === 'relay' ? str(local?.relayProtocol) : null,
      relayHost: localType === 'relay' ? hostOf(str(local?.url)) : null,
      localType,
      remoteType,
      jitterMs: jitter === null ? null : jitter * 1000,
      lossPct,
      bufferMs,
      kbps,
      codec: mime ? mime.replace(/^audio\//i, '').toLowerCase() : null,
      playoutMs,
      captureMs,
      codecMs,
      mouthToEarMs,
      engine: 'webrtc',
      measuredMs: null,
      ll: null
    },
    snapshot
  }
}

/** `turn:turn.example.com:3478?transport=udp` → `turn.example.com`. */
export function hostOf(url: string | null): string | null {
  if (!url) return null
  const m = /^(?:stun|turns?):(?:\[([^\]]+)\]|([^?:]+))/i.exec(url)
  return m ? (m[1] ?? m[2]) : null
}

export function routeLabel(s: LinkStats): string {
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
