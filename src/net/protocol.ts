/**
 * What goes over the WebSocket between each member and their room (a
 * Durable Object, see worker/room.ts). The room keeps the roster and passes
 * WebRTC signalling between members; the voice itself goes straight between
 * members over their own peer connections.
 *
 * Shared by the app and the Worker, so both sides validate the same way.
 */

/** Bump when old and new clients can't share a room any more. */
export const PROTOCOL_VERSION = 2
export const MAX_NAME_LENGTH = 32
export const MAX_MEMBERS = 12
/** Longest message either side will send or accept. An audio offer is ~3 KB. */
export const MAX_MESSAGE_CHARS = 16 * 1024
const MAX_SDP_CHARS = 12 * 1024
const MAX_CANDIDATE_CHARS = 1024

/** Sent as plain text every few seconds; the room answers `pong` without waking up. */
export const PING = 'ping'
export const PONG = 'pong'

/** How the room closes a socket it won't keep. */
export const CLOSE = {
  /** Said goodbye. */
  left: 1000,
  /** Went quiet: no ping for too long. */
  timeout: 4000,
  /** The same member connected again on another socket. */
  replaced: 4001,
  /** Broke the protocol (bad JSON, unknown message, no hello). */
  bad: 4008,
  notFound: 4004,
  full: 4009,
  version: 4010,
  /** Sent messages too fast. */
  slow: 4029
} as const

export interface Member {
  /** Derived by the room from the member's secret key (see memberIdFromKey); what everyone signals to. */
  id: string
  name: string
  /** Room clock, ms. Join order, which also keeps seats stable. */
  joinedAt: number
  muted: boolean
  deafened: boolean
  /** Has the experimental low-latency engine on (pairs who both do use it). */
  ll: boolean
  /** Lost touch with the room and has a few seconds to come back before they're dropped. */
  away: boolean
}

/** Each pair has a voice connection, and a second one for the low-latency engine when both have it on. */
export type LinkKind = 'voice' | 'll'

export interface SessionDescription {
  type: 'offer' | 'answer'
  sdp: string
}

export interface IceCandidate {
  candidate: string
  sdpMid: string | null
  sdpMLineIndex: number | null
  usernameFragment: string | null
}

/**
 * One step of setting up (or tearing down) a peer connection. `link` is a
 * fresh id the offerer picks for each connection, so a late message for an
 * old one never lands on its replacement.
 */
export type Signal =
  | { kind: LinkKind; link: string; sdp: SessionDescription }
  | { kind: LinkKind; link: string; ice: IceCandidate }
  | { kind: LinkKind; link: string; bye: true }

export type ClientMsg =
  /**
   * `key`: the member's secret (see newMemberKey). Coming back with the same
   * key is coming back as the same member. `resume`: when they first joined
   * (room clock), if they were in this room before; a room that's gone
   * meanwhile (a deploy restarts every room) is then made again, and they
   * keep their place in line.
   */
  | { t: 'hello'; v: number; key: string; name: string; muted: boolean; deafened: boolean; ll: boolean; resume: number | null }
  | { t: 'state'; muted: boolean; deafened: boolean; ll: boolean }
  | { t: 'signal'; to: string; signal: Signal }
  | { t: 'leave' }

export type ServerMsg =
  | { t: 'welcome'; id: string }
  | { t: 'roster'; members: Member[] }
  /** `from` is stamped by the room, so nobody can pretend to be someone else. */
  | { t: 'signal'; from: string; signal: Signal }

type Obj = Record<string, unknown>

function isObj(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

const isBool = (x: unknown): x is boolean => typeof x === 'boolean'
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const isStr = (x: unknown, max: number): x is string => typeof x === 'string' && x.length <= max

// ---- identity ---------------------------------------------------------------

const KEY_RE = /^[A-Za-z0-9_-]{43}$/
const MEMBER_ID_RE = /^[0-9a-f]{32}$/
const LINK_ID_RE = /^[0-9a-f]{16}$/

/** 32 random bytes, base64url. Only ever sent to the room, which keeps nothing but its hash. */
export function newMemberKey(): string {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export function isMemberKey(key: unknown): key is string {
  return typeof key === 'string' && KEY_RE.test(key)
}

/**
 * A member's public id: the first 128 bits of SHA-256 of their key. The
 * room works it out, so ids can't be chosen, and only whoever has the key
 * can come back as that member.
 */
export async function memberIdFromKey(key: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))
  return Array.from(hash.subarray(0, 16), x => x.toString(16).padStart(2, '0')).join('')
}

export function isMemberId(id: unknown): id is string {
  return typeof id === 'string' && MEMBER_ID_RE.test(id)
}

export function isLinkId(id: unknown): id is string {
  return typeof id === 'string' && LINK_ID_RE.test(id)
}

// ---- parsing ----------------------------------------------------------------

export function cleanName(name: unknown): string {
  if (typeof name !== 'string') return ''
  // Collapse whitespace and drop control characters; keep emoji and everything else.
  return name
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
}

/** Rebuilds a signal from known fields only, so nothing else is ever passed along. */
export function parseSignal(raw: unknown): Signal | null {
  if (!isObj(raw)) return null
  const { kind, link } = raw
  if ((kind !== 'voice' && kind !== 'll') || !isLinkId(link)) return null
  if (raw.bye === true) return { kind, link, bye: true }
  if (isObj(raw.sdp)) {
    const { type, sdp } = raw.sdp
    if ((type !== 'offer' && type !== 'answer') || !isStr(sdp, MAX_SDP_CHARS) || !sdp) return null
    return { kind, link, sdp: { type, sdp } }
  }
  if (isObj(raw.ice)) {
    const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = raw.ice
    if (!isStr(candidate, MAX_CANDIDATE_CHARS)) return null
    if (sdpMid != null && !isStr(sdpMid, 64)) return null
    if (sdpMLineIndex != null && !(Number.isInteger(sdpMLineIndex) && (sdpMLineIndex as number) >= 0 && (sdpMLineIndex as number) < 64)) return null
    if (usernameFragment != null && !isStr(usernameFragment, 256)) return null
    return {
      kind,
      link,
      ice: {
        candidate,
        sdpMid: (sdpMid as string | null | undefined) ?? null,
        sdpMLineIndex: (sdpMLineIndex as number | null | undefined) ?? null,
        usernameFragment: (usernameFragment as string | null | undefined) ?? null
      }
    }
  }
  return null
}

export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (!isObj(raw)) return null
  switch (raw.t) {
    case 'hello': {
      const name = cleanName(raw.name)
      if (!isNum(raw.v) || !isMemberKey(raw.key) || !name || !isBool(raw.muted) || !isBool(raw.deafened) || !isBool(raw.ll)) return null
      const resume = raw.resume === null ? null : isNum(raw.resume) ? raw.resume : undefined
      if (resume === undefined) return null
      return { t: 'hello', v: raw.v, key: raw.key, name, muted: raw.muted, deafened: raw.deafened, ll: raw.ll, resume }
    }
    case 'state':
      if (!isBool(raw.muted) || !isBool(raw.deafened) || !isBool(raw.ll)) return null
      return { t: 'state', muted: raw.muted, deafened: raw.deafened, ll: raw.ll }
    case 'signal': {
      const signal = parseSignal(raw.signal)
      return isMemberId(raw.to) && signal ? { t: 'signal', to: raw.to, signal } : null
    }
    case 'leave':
      return { t: 'leave' }
    default:
      return null
  }
}

function parseMember(raw: unknown): Member | null {
  if (!isObj(raw)) return null
  const name = cleanName(raw.name)
  if (!isMemberId(raw.id) || !name || !isNum(raw.joinedAt)) return null
  if (!isBool(raw.muted) || !isBool(raw.deafened) || !isBool(raw.ll) || !isBool(raw.away)) return null
  return { id: raw.id, name, joinedAt: raw.joinedAt, muted: raw.muted, deafened: raw.deafened, ll: raw.ll, away: raw.away }
}

export function parseServerMsg(raw: unknown): ServerMsg | null {
  if (!isObj(raw)) return null
  switch (raw.t) {
    case 'welcome':
      return isMemberId(raw.id) ? { t: 'welcome', id: raw.id } : null
    case 'roster': {
      if (!Array.isArray(raw.members) || raw.members.length > MAX_MEMBERS) return null
      const members: Member[] = []
      const seen = new Set<string>()
      for (const m of raw.members) {
        const member = parseMember(m)
        if (!member || seen.has(member.id)) return null
        seen.add(member.id)
        members.push(member)
      }
      return { t: 'roster', members: sortMembers(members) }
    }
    case 'signal': {
      const signal = parseSignal(raw.signal)
      return isMemberId(raw.from) && signal ? { t: 'signal', from: raw.from, signal } : null
    }
    default:
      return null
  }
}

/** Join order, ties broken by id so everyone agrees. */
export function sortMembers(members: Member[]): Member[] {
  return members.sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
