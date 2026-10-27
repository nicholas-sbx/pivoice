import type { IceCandidate, LinkKind, Signal } from './protocol'

/**
 * One RTCPeerConnection to one person, set up through the room. The one
 * with the smaller id always makes the offer, so two never cross. ICE
 * candidates trickle both ways as they're found; any that arrive before
 * the other side's description wait for it.
 */

export interface PeerLinkOptions {
  iceServers: RTCIceServer[]
  /** Applied to our own descriptions before they're set and sent (see sdp.ts). */
  sdpTransform?: (sdp: string) => string
  /** Hand a signal to the room for the other end. */
  signal(signal: Signal): void
}

type SignalBody = { sdp: { type: 'offer' | 'answer'; sdp: string } } | { ice: IceCandidate } | { bye: true }

const MAX_PENDING_CANDIDATES = 64

export class PeerLink {
  readonly pc: RTCPeerConnection
  private pending: IceCandidate[] = []
  closed = false
  /** Called once, however it ended. */
  onClose: (() => void) | null = null

  constructor(
    readonly peer: string,
    readonly kind: LinkKind,
    /** Picked by the offerer; ties every signal to this one connection. */
    readonly id: string,
    readonly offerer: boolean,
    private opts: PeerLinkOptions
  ) {
    const pc = new RTCPeerConnection({ iceServers: opts.iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' })
    this.pc = pc
    pc.onicecandidate = e => {
      const c = e.candidate
      if (!c?.candidate) return
      this.send({ ice: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, usernameFragment: c.usernameFragment } })
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.close()
    }
  }

  /** Offerer: once whatever this link carries has been added. */
  async offer() {
    try {
      const offer = await this.pc.createOffer()
      const sdp = this.transform(offer.sdp)
      await this.pc.setLocalDescription({ type: 'offer', sdp })
      this.send({ sdp: { type: 'offer', sdp } })
    } catch (e) {
      this.fail('offer', e)
    }
  }

  /** Answerer: their offer. `prepare` runs after it's set and before we answer, to attach what we send. */
  async answer(sdp: string, prepare?: () => void) {
    try {
      await this.pc.setRemoteDescription({ type: 'offer', sdp })
      await this.flush()
      if (this.closed) return
      prepare?.()
      const answer = await this.pc.createAnswer()
      const ours = this.transform(answer.sdp)
      await this.pc.setLocalDescription({ type: 'answer', sdp: ours })
      this.send({ sdp: { type: 'answer', sdp: ours } })
    } catch (e) {
      this.fail('answer', e)
    }
  }

  /** The rest of the conversation: their answer, their candidates, their goodbye. */
  async onSignal(signal: Signal) {
    if (this.closed) return
    try {
      if ('bye' in signal) this.close(false)
      else if ('ice' in signal) {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(signal.ice)
        else if (this.pending.length < MAX_PENDING_CANDIDATES) this.pending.push(signal.ice)
      } else if (signal.sdp.type === 'answer' && this.offerer && this.pc.signalingState === 'have-local-offer') {
        await this.pc.setRemoteDescription(signal.sdp)
        await this.flush()
      }
    } catch (e) {
      // A candidate that doesn't fit is harmless; a bad answer means starting over.
      if (!('ice' in signal)) this.fail('signal', e)
    }
  }

  /** `sayBye`: tell the other end, so they don't wait to notice. */
  close(sayBye = true) {
    if (this.closed) return
    if (sayBye) this.send({ bye: true })
    this.closed = true
    this.pc.close()
    this.onClose?.()
  }

  private async flush() {
    const pending = this.pending
    this.pending = []
    for (const c of pending) await this.pc.addIceCandidate(c).catch(() => {})
  }

  private transform(sdp: string | undefined): string {
    return this.opts.sdpTransform ? this.opts.sdpTransform(sdp ?? '') : (sdp ?? '')
  }

  private send(body: SignalBody) {
    if (!this.closed) this.opts.signal({ kind: this.kind, link: this.id, ...body } as Signal)
  }

  private fail(what: string, e: unknown) {
    if (this.closed) return
    console.warn(`${this.kind} link ${what} failed`, e)
    this.close()
  }
}
