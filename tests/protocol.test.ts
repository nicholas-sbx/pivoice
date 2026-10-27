import { describe, expect, it } from 'vitest'
import {
  MAX_MEMBERS,
  cleanName,
  isMemberId,
  isMemberKey,
  memberIdFromKey,
  newMemberKey,
  parseClientMsg,
  parseServerMsg,
  parseSignal,
  type Member
} from '../src/net/protocol'
import { codeFromHash, generateRoomCode, isRoomCode, normalizeRoomCode } from '../src/lib/roomCode'

const member = (n: number, extra: Partial<Member> = {}): Member => ({
  id: n.toString(16).padStart(32, '0'),
  name: 'P' + n,
  joinedAt: n * 10,
  muted: false,
  deafened: false,
  ll: false,
  away: false,
  ...extra
})

const KEY = 'A'.repeat(43)
const hello = (extra: Record<string, unknown> = {}) => ({ t: 'hello', v: 2, key: KEY, name: 'Ada', muted: false, deafened: false, ll: false, resume: null, ...extra })

describe('room codes', () => {
  it('generates valid codes', () => {
    for (let i = 0; i < 50; i++) expect(isRoomCode(generateRoomCode())).toBe(true)
  })
  it('normalises what people type', () => {
    expect(normalizeRoomCode(' abc-234 ')).toBe('ABC234')
    expect(normalizeRoomCode('O0I1L5S')).toBe('')
  })
  it('reads invite links', () => {
    expect(codeFromHash('#abc234')).toBe('ABC234')
    expect(codeFromHash('#nope')).toBe('')
  })
})

describe('identity', () => {
  it('makes keys that check out, and different every time', () => {
    const a = newMemberKey()
    expect(isMemberKey(a)).toBe(true)
    expect(a).not.toBe(newMemberKey())
    expect(isMemberKey('short')).toBe(false)
  })
  it('derives the same public id from the same key, and nothing else', async () => {
    const key = newMemberKey()
    const id = await memberIdFromKey(key)
    expect(isMemberId(id)).toBe(true)
    expect(await memberIdFromKey(key)).toBe(id)
    expect(await memberIdFromKey(newMemberKey())).not.toBe(id)
  })
})

describe('messages', () => {
  it('accepts a good hello and cleans the name', () => {
    expect(parseClientMsg(hello({ name: '  Ada \u0007  Lovelace ', deafened: true }))).toEqual(hello({ name: 'Ada Lovelace', deafened: true }))
    expect(parseClientMsg(hello({ resume: 1234 }))).toMatchObject({ resume: 1234 })
  })
  it('rejects junk', () => {
    expect(parseClientMsg(hello({ name: '   ' }))).toBeNull()
    expect(parseClientMsg(hello({ key: 'not-a-key' }))).toBeNull()
    expect(parseClientMsg(hello({ resume: 'yesterday' }))).toBeNull()
    expect(parseClientMsg({ t: 'state', muted: 'yes', deafened: false, ll: false })).toBeNull()
    expect(parseClientMsg('hello')).toBeNull()
    expect(parseClientMsg({ t: 'nope' })).toBeNull()
  })
  it('caps names', () => {
    expect(cleanName('x'.repeat(100)).length).toBe(32)
  })
  it('sorts the roster by join order', () => {
    const msg = parseServerMsg({ t: 'roster', members: [member(3), member(1), member(2)] })
    expect(msg?.t === 'roster' && msg.members.map(m => m.name)).toEqual(['P1', 'P2', 'P3'])
  })
  it('rejects rosters with bad or duplicate members', () => {
    expect(parseServerMsg({ t: 'roster', members: [member(1), member(1)] })).toBeNull()
    expect(parseServerMsg({ t: 'roster', members: [{ ...member(1), id: 'evil' }] })).toBeNull()
    const many = Array.from({ length: MAX_MEMBERS + 1 }, (_, i) => member(i))
    expect(parseServerMsg({ t: 'roster', members: many })).toBeNull()
  })
})

describe('signals', () => {
  const link = '0123456789abcdef'
  it('passes descriptions, candidates and goodbyes', () => {
    expect(parseSignal({ kind: 'voice', link, sdp: { type: 'offer', sdp: 'v=0' } })).toEqual({ kind: 'voice', link, sdp: { type: 'offer', sdp: 'v=0' } })
    expect(parseSignal({ kind: 'll', link, ice: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } })).toEqual({
      kind: 'll',
      link,
      ice: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null }
    })
    expect(parseSignal({ kind: 'voice', link, bye: true })).toEqual({ kind: 'voice', link, bye: true })
  })
  it('keeps only the fields it knows', () => {
    const s = parseSignal({ kind: 'voice', link, sdp: { type: 'answer', sdp: 'v=0', extra: 1 }, from: 'someone else' })
    expect(s).toEqual({ kind: 'voice', link, sdp: { type: 'answer', sdp: 'v=0' } })
  })
  it('rejects anything off', () => {
    expect(parseSignal({ kind: 'video', link, bye: true })).toBeNull()
    expect(parseSignal({ kind: 'voice', link: 'x', bye: true })).toBeNull()
    expect(parseSignal({ kind: 'voice', link, sdp: { type: 'pranswer', sdp: 'v=0' } })).toBeNull()
    expect(parseSignal({ kind: 'voice', link, sdp: { type: 'offer', sdp: 'x'.repeat(20_000) } })).toBeNull()
    expect(parseSignal({ kind: 'voice', link, ice: { candidate: 'c', sdpMLineIndex: -1 } })).toBeNull()
    expect(parseSignal({ kind: 'voice', link })).toBeNull()
  })
  it('only lets a member signal another member', () => {
    expect(parseClientMsg({ t: 'signal', to: member(1).id, signal: { kind: 'voice', link, bye: true } })).not.toBeNull()
    expect(parseClientMsg({ t: 'signal', to: 'everyone', signal: { kind: 'voice', link, bye: true } })).toBeNull()
  })
})
