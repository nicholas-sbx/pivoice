import { randomId, secureInt } from './rng'

/** No 0/O, 1/I/L or 5/S: codes get read out loud. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRTUVWXYZ2346789'
export const CODE_LENGTH = 6
/** Long, app-specific prefixes so our ids don't collide with other PeerJS apps on the shared broker. */
export const ROOM_ID_PREFIX = 'pivoice-v1-room-'
export const MEMBER_ID_PREFIX = 'pivoice-v1-m-'

export function generateRoomCode(): string {
  let s = ''
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[secureInt(CODE_ALPHABET.length)]
  return s
}

/** Uppercases and drops anything that can't be part of a code. */
export function normalizeRoomCode(input: string): string {
  return input
    .toUpperCase()
    .split('')
    .filter(c => CODE_ALPHABET.includes(c))
    .join('')
    .slice(0, CODE_LENGTH)
}

export function isRoomCode(s: string): boolean {
  return s.length === CODE_LENGTH && normalizeRoomCode(s) === s
}

/** The room *is* this PeerJS id: whoever holds it on the broker is the room's host. */
export function roomPeerId(code: string): string {
  return ROOM_ID_PREFIX + code
}

/** Everyone in a call (the host included) also has one of these, which is what the voice calls run between. */
export function newMemberPeerId(): string {
  return MEMBER_ID_PREFIX + randomId(8)
}

export function isMemberPeerId(id: string): boolean {
  return id.startsWith(MEMBER_ID_PREFIX) && /^[0-9a-f]{16}$/.test(id.slice(MEMBER_ID_PREFIX.length))
}

/** Reads a code out of `#CODE` (what invite links look like). */
export function codeFromHash(hash: string): string {
  const code = normalizeRoomCode(hash.replace(/^#/, ''))
  return isRoomCode(code) ? code : ''
}
