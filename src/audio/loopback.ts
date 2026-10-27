import { tuneOpusSdp } from '../net/sdp'
import { captureToSpeakerMs, summarise } from '../net/stats'

/**
 * Mic test through WebRTC's audio stack, with no network: two peer
 * connections in this tab, our mic into one, played out of the other the
 * way a call plays (a plain <audio> element). Same SDP tuning as a call,
 * so what you hear is what the people you talk to hear, minus the wire.
 */
export class WebRTCLoopback {
  private a = new RTCPeerConnection()
  private b = new RTCPeerConnection()
  private el = new Audio()
  private samples: number[] = []
  private closed = false

  constructor(
    private track: MediaStreamTrack,
    private dtx: boolean,
    private outputId: string
  ) {}

  async start() {
    const { a, b } = this
    a.onicecandidate = e => e.candidate && void b.addIceCandidate(e.candidate).catch(() => {})
    b.onicecandidate = e => e.candidate && void a.addIceCandidate(e.candidate).catch(() => {})
    b.ontrack = e => {
      this.el.srcObject = new MediaStream([e.track])
      if (this.outputId) void this.el.setSinkId?.(this.outputId).catch(() => {})
      void this.el.play().catch(() => {})
    }
    a.addTrack(this.track, new MediaStream([this.track]))
    const tune = (sdp: string | undefined) => tuneOpusSdp(sdp ?? '', { dtx: this.dtx })
    const offer = await a.createOffer()
    await a.setLocalDescription({ type: 'offer', sdp: tune(offer.sdp) })
    await b.setRemoteDescription({ type: 'offer', sdp: tune(offer.sdp) })
    const answer = await b.createAnswer()
    await b.setLocalDescription({ type: 'answer', sdp: tune(answer.sdp) })
    await a.setRemoteDescription({ type: 'answer', sdp: tune(answer.sdp) })
  }

  /** Capture to speakers, measured (median of the last few), and what the receive side is doing. */
  async measure(): Promise<{ ms: number | null; bufferMs: number | null }> {
    if (this.closed) return { ms: null, bufferMs: null }
    const receiver = this.b.getReceivers().find(r => r.track?.kind === 'audio')
    const { stats } = summarise((await this.b.getStats()).values() as Iterable<Record<string, unknown>>)
    const ms = captureToSpeakerMs(receiver?.getSynchronizationSources()[0], stats.playoutMs)
    if (ms !== null) {
      this.samples.push(ms)
      if (this.samples.length > 5) this.samples.shift()
    }
    const sorted = [...this.samples].sort((x, y) => x - y)
    return { ms: sorted.length ? sorted[sorted.length >> 1] : null, bufferMs: stats.bufferMs }
  }

  stop() {
    this.closed = true
    this.el.pause()
    this.el.srcObject = null
    this.a.close()
    this.b.close()
    this.track.stop()
  }
}
