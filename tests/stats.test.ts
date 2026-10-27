import { describe, expect, it } from 'vitest'
import { hostOf, pingLevel, routeLabel, summarise } from '../src/net/stats'

function report(opts: { local?: string; remote?: string; rtt?: number; inbound?: Record<string, number>; firefox?: boolean }) {
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
    { type: 'remote-candidate', id: 'R1', candidateType: opts.remote ?? 'srflx', protocol: 'udp' },
    { type: 'codec', id: 'C1', mimeType: 'audio/opus' },
    {
      type: 'inbound-rtp',
      id: 'I1',
      kind: 'audio',
      codecId: 'C1',
      timestamp: 2000,
      jitter: 0.004,
      packetsLost: 2,
      packetsReceived: 198,
      bytesReceived: 20_000,
      jitterBufferDelay: 4000,
      jitterBufferEmittedCount: 100_000,
      ...opts.inbound
    }
  ]
}

describe('summarise', () => {
  it('reads ping, route and receive side from Chrome-style stats', () => {
    const { stats } = summarise(report({ rtt: 0.042 }))
    expect(stats.rttMs).toBeCloseTo(42)
    expect(stats.route).toBe('direct')
    expect(stats.protocol).toBe('udp')
    expect(stats.codec).toBe('opus')
    expect(stats.jitterMs).toBeCloseTo(4)
    expect(stats.lossPct).toBeCloseTo(1)
    expect(stats.bufferMs).toBeCloseTo(40)
    // No capture or playout figures here: half the round trip, the buffer and the codec.
    expect(stats.mouthToEarMs).toBeCloseTo(21 + 40 + 16.5)
    expect(routeLabel(stats)).toBe('Direct, peer to peer')
  })

  it('finds the selected pair the Firefox way', () => {
    const { stats } = summarise(report({ rtt: 0.01, firefox: true, local: 'host', remote: 'host' }))
    expect(stats.route).toBe('local')
    expect(routeLabel(stats)).toBe('Same network')
  })

  it('says which TURN server we relay through', () => {
    const { stats } = summarise(report({ rtt: 0.1, local: 'relay' }))
    expect(stats.route).toBe('relay')
    expect(stats.relayHost).toBe('turn.cloudflare.com')
    expect(stats.relayProtocol).toBe('tcp')
    expect(routeLabel(stats)).toBe('Relayed via turn.cloudflare.com')
    expect(routeLabel(summarise(report({ remote: 'relay' })).stats)).toBe('Relayed via their TURN')
  })

  it('works out rates from the change since last time', () => {
    const first = summarise(report({}))
    const { stats } = summarise(
      report({
        inbound: {
          timestamp: 3000,
          packetsLost: 2,
          packetsReceived: 298,
          bytesReceived: 28_000,
          jitterBufferDelay: 4000 + 0.02 * 48_000,
          jitterBufferEmittedCount: 100_000 + 48_000
        }
      }),
      first.snapshot
    )
    expect(stats.lossPct).toBe(0)
    expect(stats.kbps).toBeCloseTo(64)
    expect(stats.bufferMs).toBeCloseTo(20)
  })

  it('adds playout and capture to mouth-to-ear when the browser reports them', () => {
    const r = [
      ...report({ rtt: 0.002 }).map(s => (s.type === 'inbound-rtp' ? { ...s, playoutId: 'P1' } : s)),
      { type: 'media-playout', id: 'P1', kind: 'audio', totalPlayoutDelay: 30 * 48, totalSamplesCount: 48_000 }
    ]
    const { stats } = summarise(r, null, { captureMs: 10 })
    expect(stats.playoutMs).toBeCloseTo(30)
    expect(stats.mouthToEarMs).toBeCloseTo(10 + 16.5 + 1 + 40 + 30)
  })

  it('falls back to RTCP round trip time', () => {
    const r = [...report({}), { type: 'remote-inbound-rtp', id: 'RR', kind: 'audio', roundTripTime: 0.033 }]
    expect(summarise(r).stats.rttMs).toBeCloseTo(33)
  })

  it('copes with an empty report', () => {
    const { stats, snapshot } = summarise([])
    expect(stats.rttMs).toBeNull()
    expect(stats.route).toBeNull()
    expect(snapshot).toBeNull()
    expect(routeLabel(stats)).toBe('Connecting…')
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
