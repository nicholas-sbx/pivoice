/**
 * Low-latency Opus, by editing the SDP each side sends.
 *
 * - `a=ptime:10` / `minptime=10`: ask for 10 ms frames instead of 20 ms,
 *   which takes 10 ms of packetisation delay off every hop (libwebrtc picks
 *   the Opus frame size from the remote description's ptime).
 * - `useinbandfec=1`: in-band FEC costs no extra latency and covers single
 *   lost packets without waiting for anything.
 * - `stereo=0`: mono voice.
 * - `usedtx=1`: discontinuous transmission. When you're quiet the encoder
 *   sends a tiny comfort-noise update every 400 ms instead of 50 packets a
 *   second, and picks back up on the very first frame of speech, so nothing
 *   gets clipped (a level gate of our own would lose the start of words).
 *   It isn't free: measured in Chrome, the receiver's jitter buffer sits
 *   about 9 ms deeper with it (36 vs 27 ms), so it's a setting. These
 *   parameters describe what *we* want to receive, so each person's own
 *   choice decides whether the people talking to them use it.
 * - `maxaveragebitrate`: a bit more headroom than the 32 kbps default, since
 *   there's no noise suppression to make the signal easy to code.
 */
export const OPUS_PARAMS: Record<string, string> = {
  minptime: '10',
  useinbandfec: '1',
  stereo: '0',
  'sprop-stereo': '0',
  usedtx: '1',
  maxaveragebitrate: '64000'
}
export const PTIME_MS = 10
/** Opus's encoder lookahead in VoIP mode, the other fixed cost of each frame. */
export const OPUS_LOOKAHEAD_MS = 6.5

export interface OpusTuning {
  dtx: boolean
}

export const ABS_CAPTURE_TIME = 'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time'

/**
 * Ask for the abs-capture-time RTP header extension on audio: each frame
 * then carries the wall-clock time it was captured at, and the receiver's
 * getSynchronizationSources() reports it next to when it was played out.
 * That's a real mouth-to-ear measurement of the WebRTC path (exact on one
 * machine). Chrome supports it but doesn't offer it, so we add it to our
 * offers, under an id the section isn't using; answers echo what was
 * offered, and we never add it to an answer ourselves.
 */
export function addAbsCaptureTime(sdp: string): string {
  if (!sdp.includes('a=setup:actpass') || sdp.includes(ABS_CAPTURE_TIME)) return sdp
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n'
  const lines = sdp.split(eol)
  const start = lines.findIndex(l => l.startsWith('m=audio'))
  if (start < 0) return sdp
  let end = lines.findIndex((l, i) => i > start && l.startsWith('m='))
  if (end < 0) end = lines.length
  const used = new Set<number>()
  for (let i = start; i < end; i++) {
    const m = /^a=extmap:(\d+)/.exec(lines[i])
    if (m) used.add(Number(m[1]))
  }
  let id = 1
  while (used.has(id) && id <= 14) id++
  if (id > 14) return sdp
  // Next to the other extmaps, or straight after the m= line.
  let at = start + 1
  for (let i = start; i < end; i++) if (lines[i].startsWith('a=extmap:')) at = i + 1
  lines.splice(at, 0, `a=extmap:${id} ${ABS_CAPTURE_TIME}`)
  return lines.join(eol)
}

export function tuneOpusSdp(sdp: string, tuning: OpusTuning = { dtx: true }): string {
  sdp = addAbsCaptureTime(sdp)
  const wanted = { ...OPUS_PARAMS, usedtx: tuning.dtx ? '1' : '0' }
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
      for (const [k, v] of Object.entries(wanted)) params.set(k, v)
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
