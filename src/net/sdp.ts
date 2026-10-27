/**
 * Low-latency Opus, by editing the SDP each side sends.
 *
 * - `a=ptime:10` / `minptime=10`: ask for 10 ms frames instead of 20 ms,
 *   which takes 10 ms of packetisation delay off every hop (libwebrtc picks
 *   the Opus frame size from the remote description's ptime).
 * - `useinbandfec=1`: in-band FEC costs no extra latency and covers single
 *   lost packets without waiting for anything.
 * - `stereo=0`, `usedtx=0`: mono voice, and no discontinuous transmission so
 *   the jitter buffer never has to re-settle after a silence.
 * - `maxaveragebitrate`: a bit more headroom than the 32 kbps default, since
 *   there's no noise suppression to make the signal easy to code.
 */
export const OPUS_PARAMS: Record<string, string> = {
  minptime: '10',
  useinbandfec: '1',
  stereo: '0',
  'sprop-stereo': '0',
  usedtx: '0',
  maxaveragebitrate: '64000'
}
export const PTIME_MS = 10

export function tuneOpusSdp(sdp: string): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n'
  const lines = sdp.split(eol)
  const opus = new Set<string>()
  for (const line of lines) {
    const m = /^a=rtpmap:(\d+) opus\/48000/i.exec(line)
    if (m) opus.add(m[1])
  }
  if (!opus.size) return sdp

  const out: string[] = []
  let inAudio = false
  let audioHasPtime = false
  const flushAudio = () => {
    if (inAudio && !audioHasPtime) out.push(`a=ptime:${PTIME_MS}`)
  }
  for (const line of lines) {
    if (line.startsWith('m=')) {
      flushAudio()
      inAudio = line.startsWith('m=audio')
      audioHasPtime = false
      out.push(line)
      continue
    }
    if (inAudio && line.startsWith('a=ptime:')) {
      audioHasPtime = true
      out.push(`a=ptime:${PTIME_MS}`)
      continue
    }
    const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(line)
    if (inAudio && fmtp && opus.has(fmtp[1])) {
      const params = new Map<string, string>()
      for (const part of fmtp[2].split(';')) {
        const [k, ...v] = part.trim().split('=')
        if (k) params.set(k, v.join('='))
      }
      for (const [k, v] of Object.entries(OPUS_PARAMS)) params.set(k, v)
      out.push(`a=fmtp:${fmtp[1]} ${[...params].map(([k, v]) => `${k}=${v}`).join(';')}`)
      continue
    }
    // An empty last line (the SDP's trailing CRLF) closes the section too.
    if (line === '' && inAudio) {
      flushAudio()
      inAudio = false
    }
    out.push(line)
  }
  flushAudio()
  return out.join(eol)
}
