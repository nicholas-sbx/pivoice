import { secureInt } from './rng'

/** No 0/O, 1/I/L or 5/S: codes get read out loud. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRTUVWXYZ2346789'
export const CODE_LENGTH = 6

/** About 594 million codes. The Worker picks them, never the browser asking. */
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

/** Reads a code out of `#CODE` (what invite links look like). */
export function codeFromHash(hash: string): string {
  const code = normalizeRoomCode(hash.replace(/^#/, ''))
  return isRoomCode(code) ? code : ''
}
