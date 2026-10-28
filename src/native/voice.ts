import { SPEAKING_HOLD_MS, SPEAKING_RMS, type MicProblem } from '../audio/engine'
import type { Member } from '../net/protocol'
import type { NativeBridge } from './bridge'
import type { AppConfig, AppDevice, AppStats, AudioInfo } from './protocol'

/**
 * What you hear and say, when the app is doing it: the page's stand-in
 * for AudioEngine and the low-latency engine together. Everything here
 * is a message to the app or the last thing it told us; the audio never
 * touches the page.
 */
export class NativeVoice {
  micProblem: MicProblem = null
  info: AudioInfo | null = null
  private micOn = true
  private self = 0
  private loudAt = new Map<string, number>()
  private angles = new Map<string, number>()
  private off: () => void

  constructor(private bridge: NativeBridge) {
    this.off = bridge.on(m => {
      if (m.t === 'levels') {
        const now = performance.now()
        this.self = m.self
        if (m.self > SPEAKING_RMS) this.loudAt.set('', now)
        for (const [id, v] of Object.entries(m.remotes)) if (v > SPEAKING_RMS) this.loudAt.set(id, now)
      } else if (m.t === 'audio' && m.on) this.info = m.info ?? null
    })
  }

  /** Open the sound card with these settings. */
  async start(cfg: AppConfig) {
    this.configure(cfg)
    const a = await this.bridge.request({ t: 'audio', on: true }, 'audio', 5000)
    if (!a?.on) this.micProblem = 'failed'
    else {
      this.info = a.info ?? null
      this.micProblem = a.micProblem ?? null
    }
  }

  configure(cfg: AppConfig) {
    this.bridge.send({ t: 'config', config: JSON.parse(JSON.stringify(cfg)) as AppConfig })
  }

  setSelf(muted: boolean, deafened: boolean) {
    this.micOn = !muted
    this.bridge.send({ t: 'self', muted, deafened })
  }

  /** Who's deafened (nobody sends to them). */
  setMembers(members: Member[]) {
    this.bridge.send({ t: 'members', members: members.map(m => ({ id: m.id, deafened: m.deafened })) })
  }

  setVolume(id: string, volume: number) {
    this.bridge.send({ t: 'peer', id, volume })
  }

  setSilenced(id: string, silenced: boolean) {
    this.bridge.send({ t: 'peer', id, silenced })
  }

  /** Where they sit (for spatial audio). Called every frame while seats move, so only real changes go out. */
  setAngle(id: string, angle: number) {
    const prev = this.angles.get(id)
    if (prev !== undefined && Math.abs(prev - angle) < 0.01) return
    this.angles.set(id, angle)
    this.bridge.send({ t: 'peer', id, angle })
  }

  /** Who's talking right now, the same way AudioEngine.speaking decides it. `selfId` counts only while your mic's on. */
  speaking(selfId: string, now = performance.now()): Set<string> {
    const out = new Set<string>()
    for (const [id, at] of this.loudAt) {
      if (now - at >= SPEAKING_HOLD_MS) continue
      if (id === '') {
        if (this.micOn) out.add(selfId)
      } else out.add(id)
    }
    return out
  }

  /** Your microphone level, 0–1, for the meter (as AudioEngine.micLevel scales it). */
  micLevel(): number {
    return Math.min(1, this.self * 4)
  }

  stats(): Promise<AppStats | null> {
    return this.bridge.request({ t: 'stats' }, 'stats')
  }

  async devices(): Promise<AppDevice[]> {
    return (await this.bridge.request({ t: 'devices' }, 'devices'))?.devices ?? []
  }

  test(path: '' | 'raw' | 'll') {
    this.bridge.send({ t: 'test', path })
  }

  close() {
    this.bridge.send({ t: 'test', path: '' })
    this.bridge.send({ t: 'audio', on: false })
    this.off()
  }
}
