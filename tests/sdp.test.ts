import { describe, expect, it } from 'vitest'
import { tuneOpusSdp } from '../src/net/sdp'

const sdp = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 0',
  'c=IN IP4 0.0.0.0',
  'a=rtpmap:111 opus/48000/2',
  'a=rtcp-fb:111 transport-cc',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'a=rtpmap:0 PCMU/8000',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=sctp-port:5000',
  ''
].join('\r\n')

describe('tuneOpusSdp', () => {
  const out = tuneOpusSdp(sdp)

  it('asks for 10 ms frames, FEC, mono and DTX', () => {
    const fmtp = out.split('\r\n').find(l => l.startsWith('a=fmtp:111'))!
    expect(fmtp).toContain('minptime=10')
    expect(fmtp).toContain('useinbandfec=1')
    expect(fmtp).toContain('stereo=0')
    expect(fmtp).toContain('usedtx=1')
    expect(fmtp.match(/minptime/g)).toHaveLength(1)
  })

  it('adds ptime to the audio section only', () => {
    const lines = out.split('\r\n')
    const ptime = lines.indexOf('a=ptime:10')
    expect(ptime).toBeGreaterThan(lines.findIndex(l => l.startsWith('m=audio')))
    expect(ptime).toBeLessThan(lines.findIndex(l => l.startsWith('m=application')))
    expect(lines.filter(l => l.startsWith('a=ptime'))).toHaveLength(1)
  })

  it('leaves other codecs alone and keeps CRLFs', () => {
    expect(out).toContain('a=fmtp:63 111/111\r\n')
    expect(out.endsWith('\r\n')).toBe(true)
  })

  it('is idempotent', () => {
    expect(tuneOpusSdp(out)).toBe(out)
  })

  it('turns DTX off when asked', () => {
    const fmtp = tuneOpusSdp(sdp, { dtx: false }).split('\r\n').find(l => l.startsWith('a=fmtp:111'))!
    expect(fmtp).toContain('usedtx=0')
    expect(fmtp).toContain('minptime=10')
  })

  it('asks for capture timestamps in offers, under a free id', () => {
    const offer = sdp.replace('a=rtcp-fb', 'a=setup:actpass\r\na=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level\r\na=rtcp-fb')
    const out = tuneOpusSdp(offer)
    expect(out).toContain('a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time')
    expect(tuneOpusSdp(out)).toBe(out)
  })

  it('never adds it to an answer', () => {
    const answer = sdp.replace('a=rtcp-fb', 'a=setup:active\r\na=rtcp-fb')
    expect(tuneOpusSdp(answer)).not.toContain('abs-capture-time')
  })

  it('ignores SDP without Opus', () => {
    const plain = 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'
    expect(tuneOpusSdp(plain)).toBe(plain)
  })
})
