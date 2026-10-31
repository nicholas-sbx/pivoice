import { describe, expect, it } from 'vitest'
import { hostOf, pingLevel, routeLabel, routeOf } from '../src/net/stats'

function report(opts: { local?: string; remote?: string; rtt?: number; firefox?: boolean }) {
  const pair: Record<string, unknown> = {
    type: 'candidate-pair',
    id: 'CP1',
    localCandidateId: 'L1',
    remoteCandidateId: 'R1',
    state: 'succeeded',
    nominated: true
  }
  if (opts.rtt !== undefined) pair.currentRoundTripTime = opts.rtt
  if (opts.firefox) pair.selected = true
  return [
    { type: 'candidate-pair', id: 'CP0', localCandidateId: 'L0', remoteCandidateId: 'R1', state: 'failed', nominated: false },
    pair,
    ...(opts.firefox ? [] : [{ type: 'transport', id: 'T1', selectedCandidatePairId: 'CP1' }]),
    { type: 'local-candidate', id: 'L0', candidateType: 'host', protocol: 'udp' },
    {
      type: 'local-candidate',
      id: 'L1',
      candidateType: opts.local ?? 'srflx',
      protocol: 'udp',
      relayProtocol: 'tcp',
      url: 'turn:turn.cloudflare.com:3478?transport=tcp'
    },
    { type: 'remote-candidate', id: 'R1', candidateType: opts.remote ?? 'srflx', protocol: 'udp' }
  ]
}

describe('routeOf', () => {
  it('reads ping and route from Chrome-style stats', () => {
    const r = routeOf(report({ rtt: 0.042 }))
    expect(r.rttMs).toBeCloseTo(42)
    expect(r.route).toBe('direct')
    expect(r.protocol).toBe('udp')
    expect(routeLabel(r)).toBe('Direct, peer to peer')
  })

  it('finds the selected pair the Firefox way', () => {
    const r = routeOf(report({ rtt: 0.01, firefox: true, local: 'host', remote: 'host' }))
    expect(r.route).toBe('local')
    expect(routeLabel(r)).toBe('Same network')
  })

  it('says which TURN server we relay through', () => {
    const r = routeOf(report({ rtt: 0.1, local: 'relay' }))
    expect(r.route).toBe('relay')
    expect(r.relayHost).toBe('turn.cloudflare.com')
    expect(r.relayProtocol).toBe('tcp')
    expect(routeLabel(r)).toBe('Relayed via turn.cloudflare.com')
    expect(routeLabel(routeOf(report({ remote: 'relay' })))).toBe('Relayed via their TURN')
  })

  it('copes with an empty report', () => {
    const r = routeOf([])
    expect(r.rttMs).toBeNull()
    expect(r.route).toBeNull()
    expect(routeLabel(r)).toBe('Connecting…')
  })
})

describe('helpers', () => {
  it('pulls host names out of ICE urls', () => {
    expect(hostOf('turns:turn.example.com:5349?transport=tcp')).toBe('turn.example.com')
    expect(hostOf('turn:[2001:db8::1]:3478')).toBe('2001:db8::1')
    expect(hostOf(null)).toBeNull()
  })
  it('grades ping like Discord', () => {
    expect(pingLevel(30)).toBe('good')
    expect(pingLevel(120)).toBe('ok')
    expect(pingLevel(300)).toBe('bad')
  })
})
