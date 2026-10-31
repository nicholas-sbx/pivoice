import type { IceCandidate, Signal } from './protocol'

/**
 * One RTCPeerConnection to one person, set up through the room, carrying
 * only the low-latency engine's data channel (no media: see session.ts).
 * The one with the smaller id always makes the offer, so two never cross. ICE
 * candidates trickle both ways as they're found; any that arrive before
 * the other side's description wait for it.
 */

/**
 * What a session needs from one connection, whoever makes it: a PeerLink
 * here in the page, or the app (native/link.ts) when it's doing the audio.
 */
export interface Link {
  readonly peer: string
  /** Picked by the offerer; ties every signal to this one connection. */
  readonly id: string
  readonly offerer: boolean
  readonly closed: boolean
  /** Called once, however it ended. */
  onClose: (() => void) | null
  /** Offerer: once the data channel has been added. */
  offer(): Promise<void> | void
  /** Answerer: their offer. */
  answer(sdp: string): Promise<void> | void
  /** The rest of the conversation: their answer, their candidates, their goodbye. */
  onSignal(signal: Signal): Promise<void> | void
  /** `sayBye`: tell the other end, so they don't wait to notice. */
  close(sayBye?: boolean): void
}

export interface PeerLinkOptions {
  iceServers: RTCIceServer[]
  /** Hand a signal to the room for the other end. */
  signal(signal: Signal): void
}

type SignalBody = { sdp: { type: 'offer' | 'answer'; sdp: string } } | { ice: IceCandidate } | { bye: true }

const MAX_PENDING_CANDIDATES = 64

export class PeerLink implements Link {
  readonly pc: RTCPeerConnection
  private pending: IceCandidate[] = []
  closed = false
  /** Called once, however it ended. */
  onClose: (() => void) | null = null

  constructor(
    readonly peer: string,
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

  /** Offerer: once the data channel has been added. */
  async offer() {
    try {
      const offer = await this.pc.createOffer()
      const sdp = offer.sdp ?? ''
      await this.pc.setLocalDescription({ type: 'offer', sdp })
      this.send({ sdp: { type: 'offer', sdp } })
    } catch (e) {
      this.fail('offer', e)
    }
  }

  /** Answerer: their offer. */
  async answer(sdp: string) {
    try {
      await this.pc.setRemoteDescription({ type: 'offer', sdp })
      await this.flush()
      if (this.closed) return
      const answer = await this.pc.createAnswer()
      const ours = answer.sdp ?? ''
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

  private send(body: SignalBody) {
    if (!this.closed) this.opts.signal({ link: this.id, ...body } as Signal)
  }

  private fail(what: string, e: unknown) {
    if (this.closed) return
    console.warn(`link ${what} failed`, e)
    this.close()
  }
}
