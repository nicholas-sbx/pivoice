import { isMemberPeerId } from '../lib/roomCode'

/**
 * What goes over the data channel between each member and the room's host.
 * Only the roster travels here; the voice itself goes straight between
 * members over their own WebRTC calls.
 */

/** Bump when old and new clients can't share a room any more. */
export const PROTOCOL_VERSION = 1
export const MAX_NAME_LENGTH = 32
export const MAX_MEMBERS = 12

export interface Member {
  /** Their member PeerJS id; what everyone calls to hear them. */
  id: string
  name: string
  /** Host clock, ms. Join order decides who takes over the room if the host leaves. */
  joinedAt: number
  muted: boolean
  deafened: boolean
  /** Lost touch with the host and has a few seconds to come back before they're dropped. */
  away: boolean
}

export type ClientMsg =
  | { t: 'hello'; v: number; name: string; muted: boolean; deafened: boolean }
  | { t: 'state'; muted: boolean; deafened: boolean }
  | { t: 'ping'; at: number }
  | { t: 'leave' }

export type HostMsg =
  | { t: 'roster'; hostId: string; members: Member[] }
  | { t: 'pong'; at: number }
  | { t: 'full' }
  | { t: 'version'; need: number }
  /** The host is going away (or found out it isn't the host any more): go and find the room again. */
  | { t: 'rehome' }

type Obj = Record<string, unknown>

function isObj(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

const isBool = (x: unknown): x is boolean => typeof x === 'boolean'
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

export function cleanName(name: unknown): string {
  if (typeof name !== 'string') return ''
  // Collapse whitespace and drop control characters; keep emoji and everything else.
  return name
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
}

export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (!isObj(raw)) return null
  switch (raw.t) {
    case 'hello': {
      const name = cleanName(raw.name)
      if (!isNum(raw.v) || !name || !isBool(raw.muted) || !isBool(raw.deafened)) return null
      return { t: 'hello', v: raw.v, name, muted: raw.muted, deafened: raw.deafened }
    }
    case 'state':
      if (!isBool(raw.muted) || !isBool(raw.deafened)) return null
      return { t: 'state', muted: raw.muted, deafened: raw.deafened }
    case 'ping':
      return isNum(raw.at) ? { t: 'ping', at: raw.at } : null
    case 'leave':
      return { t: 'leave' }
    default:
      return null
  }
}

function parseMember(raw: unknown): Member | null {
  if (!isObj(raw)) return null
  const name = cleanName(raw.name)
  if (typeof raw.id !== 'string' || !isMemberPeerId(raw.id) || !name || !isNum(raw.joinedAt)) return null
  if (!isBool(raw.muted) || !isBool(raw.deafened) || !isBool(raw.away)) return null
  return { id: raw.id, name, joinedAt: raw.joinedAt, muted: raw.muted, deafened: raw.deafened, away: raw.away }
}

export function parseHostMsg(raw: unknown): HostMsg | null {
  if (!isObj(raw)) return null
  switch (raw.t) {
    case 'roster': {
      if (typeof raw.hostId !== 'string' || !Array.isArray(raw.members) || raw.members.length > MAX_MEMBERS) return null
      const members: Member[] = []
      const seen = new Set<string>()
      for (const m of raw.members) {
        const member = parseMember(m)
        if (!member || seen.has(member.id)) return null
        seen.add(member.id)
        members.push(member)
      }
      return { t: 'roster', hostId: raw.hostId, members: sortMembers(members) }
    }
    case 'pong':
      return isNum(raw.at) ? { t: 'pong', at: raw.at } : null
    case 'full':
      return { t: 'full' }
    case 'version':
      return isNum(raw.need) ? { t: 'version', need: raw.need } : null
    case 'rehome':
      return { t: 'rehome' }
    default:
      return null
  }
}

/** Join order, ties broken by id so everyone agrees. */
export function sortMembers(members: Member[]): Member[] {
  return members.sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * Where I am in the queue to take over the room if `hostId` disappears:
 * 0 goes first. Everyone works this out from the last roster they saw, so
 * they mostly agree without talking; when they don't, the broker only lets
 * one of them have the room id anyway.
 */
export function successorRank(members: readonly Member[], hostId: string, selfId: string): number {
  const queue = members.filter(m => m.id !== hostId)
  const i = queue.findIndex(m => m.id === selfId)
  return i < 0 ? queue.length : i
}
