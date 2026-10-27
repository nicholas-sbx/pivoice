import { seatDirection } from '../lib/seats'

/**
 * Everything you hear and say.
 *
 * Built for the lowest latency first: the microphone comes in raw (no echo
 * cancellation, noise suppression or auto gain unless you turn them on;
 * everyone's on headphones), and with spatial audio off each person plays
 * straight out of a plain <audio> element, the shortest path the browser
 * has from the network to your ears.
 *
 * With spatial audio on, each voice goes through Web Audio instead:
 *
 *   remote stream → gain (their volume) → PannerNode → master → speakers
 *
 * "Stereo" pans with the equal-power law; "HRTF" uses the browser's built-in
 * head-related transfer function, which makes voices sound like they're
 * coming from around you on headphones. Positions come from the table:
 * you sit at the bottom facing the middle and everyone else is where their
 * seat is. No head tracking: the listener never turns.
 */

export type SpatialMode = 'off' | 'stereo' | 'hrtf'

export interface MicSettings {
  deviceId: string
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
}

export type MicProblem = 'denied' | 'missing' | 'failed' | null

interface Remote {
  stream: MediaStream
  el: HTMLAudioElement
  source: MediaStreamAudioSourceNode
  analyser: AnalyserNode
  gain: GainNode
  panner: PannerNode
  angle: number
}

/** RMS above this counts as talking (about −40 dBFS). */
const SPEAKING_RMS = 0.01
/** Keep the ring lit this long after the last loud bit, so it doesn't flicker between words. */
const SPEAKING_HOLD_MS = 300

export class AudioEngine {
  readonly ctx: AudioContext
  /** What every call sends. The track inside is swapped when you change microphone. */
  readonly sendStream = new MediaStream()
  micProblem: MicProblem = null
  private master: GainNode
  private mic: { stream: MediaStream; source: MediaStreamAudioSourceNode; analyser: AnalyserNode } | null = null
  private remotes = new Map<string, Remote>()
  private mode: SpatialMode = 'off'
  private deafened = false
  private micOn = true
  private volumes = new Map<string, number>()
  private silenced = new Set<string>()
  private outputId = ''
  private buf = new Float32Array(1024)
  private loudAt = new Map<string, number>()

  constructor() {
    // Created from a click, so it starts running. 'interactive' is the
    // smallest buffer the browser will give us.
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    this.master = this.ctx.createGain()
    this.master.connect(this.ctx.destination)
  }

  /** Opens the microphone (or a silent stand-in if we can't have it) and returns the track to send. */
  async openMic(settings: MicSettings): Promise<MediaStreamTrack> {
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    let stream: MediaStream | null = null
    this.micProblem = null
    const audio = (deviceId: string): MediaTrackConstraints =>
      ({
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl,
        channelCount: 1,
        sampleRate: 48_000,
        // Not in every browser, but where it is: as little input buffering as you've got.
        latency: 0
      }) as MediaTrackConstraints
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: audio(settings.deviceId) })
    } catch (e) {
      const name = (e as DOMException).name
      if (settings.deviceId && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
        // The saved device is gone; use the default one.
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: audio('') })
        } catch (e2) {
          this.micProblem = problemFor(e2)
        }
      } else {
        this.micProblem = problemFor(e)
      }
    }

    this.mic?.source.disconnect()
    for (const t of this.mic?.stream.getTracks() ?? []) t.stop()
    this.mic = null

    let track: MediaStreamTrack
    if (stream) {
      const source = this.ctx.createMediaStreamSource(stream)
      const analyser = this.ctx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      this.mic = { stream, source, analyser }
      track = stream.getAudioTracks()[0]
    } else {
      // Listen-only: calls still need something to send.
      track = this.ctx.createMediaStreamDestination().stream.getAudioTracks()[0]
    }
    track.contentHint = 'speech'
    track.enabled = this.micOn
    for (const old of this.sendStream.getAudioTracks()) this.sendStream.removeTrack(old)
    this.sendStream.addTrack(track)
    return track
  }

  /**
   * How long the microphone takes to hand us audio, as the browser reports
   * it. Used as a stand-in for everyone's capture delay in the latency
   * breakdown, since we can't see theirs.
   */
  captureLatencyMs(): number | null {
    const track = this.mic?.stream.getAudioTracks()[0]
    const stats = (track as (MediaStreamTrack & { stats?: { averageLatency?: number } }) | undefined)?.stats
    if (stats?.averageLatency) return stats.averageLatency
    const latency = (track?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined)?.latency
    return typeof latency === 'number' && latency > 0 ? latency * 1000 : null
  }

  get micDeviceId(): string {
    return this.mic?.stream.getAudioTracks()[0]?.getSettings().deviceId ?? ''
  }

  setMicEnabled(on: boolean) {
    this.micOn = on
    for (const t of this.sendStream.getAudioTracks()) t.enabled = on
  }

  setDeafened(on: boolean) {
    this.deafened = on
    this.applyAll()
  }

  setSpatial(mode: SpatialMode) {
    this.mode = mode
    this.applyAll()
  }

  /** 0–1. */
  setVolume(id: string, volume: number) {
    this.volumes.set(id, Math.max(0, Math.min(1, volume)))
    const r = this.remotes.get(id)
    if (r) this.apply(id, r)
  }

  /** Mute someone for yourself only. */
  setSilenced(id: string, on: boolean) {
    if (on) this.silenced.add(id)
    else this.silenced.delete(id)
    const r = this.remotes.get(id)
    if (r) this.apply(id, r)
  }

  addRemote(id: string, stream: MediaStream) {
    const existing = this.remotes.get(id)
    if (existing?.stream === stream) return
    const angle = existing?.angle ?? Math.PI
    if (existing) this.removeRemote(id)

    // Chrome only feeds a remote WebRTC stream into Web Audio while a media
    // element is playing it, so there's always one (muted when Web Audio is
    // doing the playing).
    const el = new Audio()
    el.autoplay = true
    el.srcObject = stream
    if (this.outputId) void el.setSinkId?.(this.outputId).catch(() => {})

    const source = this.ctx.createMediaStreamSource(stream)
    const analyser = this.ctx.createAnalyser()
    analyser.fftSize = 1024
    const gain = this.ctx.createGain()
    const panner = new PannerNode(this.ctx, {
      panningModel: 'HRTF',
      // Direction only: nobody's quieter for sitting across the table.
      distanceModel: 'linear',
      refDistance: 1,
      maxDistance: 10_000,
      rolloffFactor: 0,
      coneInnerAngle: 360,
      coneOuterAngle: 360
    })
    source.connect(analyser)
    source.connect(gain)
    gain.connect(panner)

    const remote: Remote = { stream, el, source, analyser, gain, panner, angle }
    this.remotes.set(id, remote)
    this.apply(id, remote)
    void el.play().catch(() => {})
  }

  removeRemote(id: string) {
    const r = this.remotes.get(id)
    if (!r) return
    this.remotes.delete(id)
    this.loudAt.delete(id)
    r.el.pause()
    r.el.srcObject = null
    r.source.disconnect()
    r.gain.disconnect()
    r.panner.disconnect()
  }

  /** Where they sit, as a table angle (see lib/seats). Cheap to call every frame. */
  setAngle(id: string, angle: number) {
    const r = this.remotes.get(id)
    if (!r || r.angle === angle) return
    r.angle = angle
    if (this.mode !== 'off') this.position(r)
  }

  private position(r: Remote) {
    const { x, z } = seatDirection(r.angle)
    r.panner.positionX.value = x
    r.panner.positionY.value = 0
    r.panner.positionZ.value = z
  }

  private applyAll() {
    this.master.gain.value = this.deafened ? 0 : 1
    for (const [id, r] of this.remotes) this.apply(id, r)
  }

  private apply(id: string, r: Remote) {
    const volume = this.silenced.has(id) ? 0 : (this.volumes.get(id) ?? 1)
    if (this.mode === 'off') {
      r.panner.disconnect()
      r.el.muted = this.deafened
      r.el.volume = volume
    } else {
      r.el.muted = true
      r.gain.gain.value = volume
      r.panner.panningModel = this.mode === 'hrtf' ? 'HRTF' : 'equalpower'
      this.position(r)
      r.panner.disconnect()
      r.panner.connect(this.master)
    }
  }

  async setOutputDevice(deviceId: string) {
    this.outputId = deviceId
    const ctx = this.ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> }
    await ctx.setSinkId?.(deviceId).catch(() => {})
    for (const r of this.remotes.values()) await r.el.setSinkId?.(deviceId).catch(() => {})
  }

  static canPickOutput(): boolean {
    return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype
  }

  private rms(analyser: AnalyserNode): number {
    analyser.getFloatTimeDomainData(this.buf)
    let sum = 0
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i]
    return Math.sqrt(sum / this.buf.length)
  }

  /** Your own microphone level, 0–1, for the meter in settings. */
  micLevel(): number {
    return this.mic ? Math.min(1, this.rms(this.mic.analyser) * 4) : 0
  }

  /** Who's talking right now. `selfId` is you, counted only while your mic is on. */
  speaking(selfId: string, now = performance.now()): Set<string> {
    const out = new Set<string>()
    const check = (id: string, analyser: AnalyserNode) => {
      if (this.rms(analyser) > SPEAKING_RMS) this.loudAt.set(id, now)
      if (now - (this.loudAt.get(id) ?? -Infinity) < SPEAKING_HOLD_MS) out.add(id)
    }
    if (this.mic && this.micOn) check(selfId, this.mic.analyser)
    else this.loudAt.delete(selfId)
    for (const [id, r] of this.remotes) check(id, r.analyser)
    return out
  }

  close() {
    for (const id of [...this.remotes.keys()]) this.removeRemote(id)
    for (const t of this.mic?.stream.getTracks() ?? []) t.stop()
    for (const t of this.sendStream.getTracks()) t.stop()
    this.mic = null
    void this.ctx.close().catch(() => {})
  }
}

function problemFor(e: unknown): MicProblem {
  const name = (e as DOMException)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'missing'
  return 'failed'
}
