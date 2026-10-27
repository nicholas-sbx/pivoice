import { describe, expect, it } from 'vitest'
import { MAX_MEMBERS, cleanName, parseClientMsg, parseHostMsg, successorRank, type Member } from '../src/net/protocol'
import { codeFromHash, generateRoomCode, isMemberPeerId, isRoomCode, newMemberPeerId, normalizeRoomCode } from '../src/lib/roomCode'

const member = (n: number, extra: Partial<Member> = {}): Member => ({
  id: 'pivoice-v1-m-' + n.toString(16).padStart(16, '0'),
  name: 'P' + n,
  joinedAt: n * 10,
  muted: false,
  deafened: false,
  away: false,
  ...extra
})

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
  it('makes member ids that check out', () => {
    expect(isMemberPeerId(newMemberPeerId())).toBe(true)
    expect(isMemberPeerId('pivoice-v1-room-ABC234')).toBe(false)
  })
})

describe('messages', () => {
  it('accepts a good hello and cleans the name', () => {
    expect(parseClientMsg({ t: 'hello', v: 1, name: '  Ada \u0007  Lovelace ', muted: false, deafened: true })).toEqual({
      t: 'hello',
      v: 1,
      name: 'Ada Lovelace',
      muted: false,
      deafened: true
    })
  })
  it('rejects junk', () => {
    expect(parseClientMsg({ t: 'hello', v: 1, name: '   ', muted: false, deafened: false })).toBeNull()
    expect(parseClientMsg({ t: 'state', muted: 'yes', deafened: false })).toBeNull()
    expect(parseClientMsg('hello')).toBeNull()
    expect(parseClientMsg({ t: 'nope' })).toBeNull()
  })
  it('caps names', () => {
    expect(cleanName('x'.repeat(100)).length).toBe(32)
  })
  it('sorts the roster by join order', () => {
    const msg = parseHostMsg({ t: 'roster', hostId: member(1).id, members: [member(3), member(1), member(2)] })
    expect(msg?.t === 'roster' && msg.members.map(m => m.name)).toEqual(['P1', 'P2', 'P3'])
  })
  it('rejects rosters with bad or duplicate members', () => {
    expect(parseHostMsg({ t: 'roster', hostId: 'x', members: [member(1), member(1)] })).toBeNull()
    expect(parseHostMsg({ t: 'roster', hostId: 'x', members: [{ ...member(1), id: 'evil' }] })).toBeNull()
    const many = Array.from({ length: MAX_MEMBERS + 1 }, (_, i) => member(i))
    expect(parseHostMsg({ t: 'roster', hostId: 'x', members: many })).toBeNull()
  })
})

describe('successorRank', () => {
  const ms = [member(1), member(2), member(3), member(4)]
  it('queues everyone but the old host in join order', () => {
    expect(successorRank(ms, ms[0].id, ms[1].id)).toBe(0)
    expect(successorRank(ms, ms[0].id, ms[3].id)).toBe(2)
    expect(successorRank(ms, ms[2].id, ms[3].id)).toBe(2)
  })
  it('puts someone the roster never saw at the back', () => {
    expect(successorRank(ms, ms[0].id, 'stranger')).toBe(3)
  })
})
