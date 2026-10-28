import type { ExternalLink, ExternalLinks } from '../net/session'
import type { LinkKind, Signal } from '../net/protocol'
import type { NativeBridge } from './bridge'
import type { AppSignal, FromApp } from './protocol'

/**
 * The session's connections when the app is doing the audio: each one is
 * a peer connection in the app (native/internal/engine/link.go), and this
 * is its stand-in on the page, passing signalling between the app and
 * the room. The session still decides everything about when links come
 * and go, exactly as it does for its own.
 */
export class NativeLinks implements ExternalLinks {
  private links = new Map<string, NativeLink>()

  constructor(readonly bridge: NativeBridge) {
    bridge.on(m => this.fromApp(m))
  }

  make(peer: string, kind: LinkKind, id: string, offerer: boolean, iceServers: RTCIceServer[], signal: (s: Signal) => void): ExternalLink {
    const link = new NativeLink(this, peer, kind, id, offerer, iceServers, signal)
    this.links.set(link.key, link)
    return link
  }

  forget(key: string) {
    this.links.delete(key)
  }

  private fromApp(m: FromApp) {
    if (m.t === 'signal' || m.t === 'link') this.links.get(m.link)?.fromApp(m)
  }
}

class NativeLink implements ExternalLink {
  /**
   * The app knows it by who, what and which: link ids are picked by whoever
   * offers, so on their own they could collide with (or be made to collide
   * with) someone else's.
   */
  readonly key: string
  closed = false
  onClose: (() => void) | null = null
  onConnected: (() => void) | null = null
  onChannel: ((up: boolean) => void) | null = null

  constructor(
    private owner: NativeLinks,
    readonly peer: string,
    readonly kind: LinkKind,
    readonly id: string,
    readonly offerer: boolean,
    iceServers: RTCIceServer[],
    private signal: (s: Signal) => void
  ) {
    this.key = `${peer}:${kind}:${id}`
    owner.bridge.send({ t: 'link', op: 'open', link: this.key, peer, kind, offerer, iceServers: plain(iceServers) })
  }

  /** The app makes its offer as soon as it has the link. */
  offer() {}

  answer(sdp: string) {
    this.toApp({ sdp: { type: 'offer', sdp } })
  }

  onSignal(signal: Signal) {
    if (this.closed) return
    if ('bye' in signal) this.close(false)
    else if ('ice' in signal) this.toApp({ ice: signal.ice })
    // Offers come in through answer(); the only description we take here is the answer to ours.
    else if (signal.sdp.type === 'answer' && this.offerer) this.toApp({ sdp: signal.sdp })
  }

  close(sayBye = true) {
    if (this.closed) return
    if (sayBye) this.signal({ kind: this.kind, link: this.id, bye: true })
    this.closed = true
    this.owner.bridge.send({ t: 'link', op: 'close', link: this.key })
    this.owner.forget(this.key)
    this.onClose?.()
  }

  fromApp(m: Extract<FromApp, { t: 'signal' | 'link' }>) {
    if (this.closed) return
    if (m.t === 'signal') {
      this.signal({ kind: this.kind, link: this.id, ...m.signal } as Signal)
      return
    }
    switch (m.state) {
      case 'connected':
        this.onConnected?.()
        break
      case 'll-up':
        this.onChannel?.(true)
        break
      case 'll-down':
        this.onChannel?.(false)
        break
      case 'closed':
        // Failed in the app: as a PeerLink does, tell them and let the session start over.
        this.close()
        break
    }
  }

  private toApp(signal: AppSignal) {
    this.owner.bridge.send({ t: 'link', op: 'signal', link: this.key, signal })
  }
}

/** ICE servers as plain data (they may have come through Vue's reactivity). */
function plain(servers: RTCIceServer[]): RTCIceServer[] {
  return servers.map(s => ({ urls: s.urls, username: s.username, credential: s.credential }))
}
