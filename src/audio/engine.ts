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
 *
 * Each person has one channel strip (analyser, gain, panner) that either
 * engine can feed: the WebRTC stream above, or the low-latency engine's
 * playback node (audio/ll), which always plays through Web Audio. When both
 * are there the low-latency one wins and the WebRTC element stays muted.
 */

export type SpatialMode = 'off' | 'stereo' | 'hrtf'

/**
 * Web Audio's output buffer: the smallest the device will do (Chrome: 128
 * frames), about 5 ms where the device offers it, or the browser's default
 * (~10 ms). Smaller is less delay but crackles sooner on a busy machine.
 */
export type OutputBuffer = 'min' | 'small' | 'interactive'
const LATENCY_HINT: Record<OutputBuffer, AudioContextLatencyCategory | number> = { min: 0, small: 0.005, interactive: 'interactive' }

export interface MicSettings {
  deviceId: string
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
}

export type MicProblem = 'denied' | 'missing' | 'failed' | null

interface Remote {
  media: { stream: MediaStream; el: HTMLAudioElement; source: MediaStreamAudioSourceNode } | null
  /** The low-latency engine's playback node for them, when that's what's carrying their voice. */
  ll: AudioNode | null
  analyser: AnalyserNode
  gain: GainNode
  panner: PannerNode
  angle: number
}

/** RMS above this counts as talking (about −40 dBFS). */
export const SPEAKING_RMS = 0.01
/** Keep the ring lit this long after the last loud bit, so it doesn't flicker between words. */
export const SPEAKING_HOLD_MS = 300

export class AudioEngine {
  readonly ctx: AudioContext
  /** What every call sends. The track inside is swapped when you change microphone. */
  readonly sendStream = new MediaStream()
  micProblem: MicProblem = null
  private master: GainNode
  /**
   * The mic as heard locally: a clone of the track we send, so muting what
   * we send (track.enabled) doesn't silence the meter, the low-latency
   * engine's own gate, or the mic test.
   */
  private mic: { stream: MediaStream; local: MediaStreamTrack; source: MediaStreamAudioSourceNode; analyser: AnalyserNode } | null = null
  /** Straight to the speakers, past deafen: what the mic test plays through. */
  readonly testOut: GainNode
  private rawLoop = false
  private remotes = new Map<string, Remote>()
  private mode: SpatialMode = 'off'
  private deafened = false
  private micOn = true
  private volumes = new Map<string, number>()
  private silenced = new Set<string>()
  private outputId = ''
  private buf = new Float32Array(1024)
  private loudAt = new Map<string, number>()

  constructor(buffer: OutputBuffer = 'min') {
    // Created from a click, so it starts running. A latency hint of 0 asks
    // for the smallest output buffer the device supports (Chrome: 128
    // frames), well under what 'interactive' gets (~10 ms + device).
    // 48 kHz is what Opus and the low-latency engine run at, so nothing has
    // to be resampled on the way in or out (the browser resamples to the
    // hardware if it has to).
    this.ctx = new AudioContext({ latencyHint: LATENCY_HINT[buffer], sampleRate: 48_000 })
    this.master = this.ctx.createGain()
    this.master.connect(this.ctx.destination)
    this.testOut = this.ctx.createGain()
    this.testOut.connect(this.ctx.destination)
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
    this.mic?.local.stop()
    for (const t of this.mic?.stream.getTracks() ?? []) t.stop()
    this.mic = null

    let track: MediaStreamTrack
    let source: MediaStreamAudioSourceNode | null = null
    if (stream) {
      track = stream.getAudioTracks()[0]
      const local = track.clone()
      source = this.ctx.createMediaStreamSource(new MediaStream([local]))
      const analyser = this.ctx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      this.mic = { stream, local, source, analyser }
      if (this.rawLoop) source.connect(this.testOut)
    } else {
      // Listen-only: calls still need something to send.
      track = this.ctx.createMediaStreamDestination().stream.getAudioTracks()[0]
    }
    track.contentHint = 'speech'
    track.enabled = this.micOn
    for (const old of this.sendStream.getAudioTracks()) this.sendStream.removeTrack(old)
    this.sendStream.addTrack(track)
    this.onMic?.(source)
    return track
  }

  /** Told about every new microphone source (null when there's none), for the low-latency engine. */
  onMic: ((source: AudioNode | null) => void) | null = null

  get micSource(): AudioNode | null {
    return this.mic?.source ?? null
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

  /** Mic test, raw: the mic straight to your speakers, nothing in between but the browser's own buffers. */
  setRawLoopback(on: boolean) {
    if (on === this.rawLoop) return
    this.rawLoop = on
    if (!this.mic) return
    if (on) this.mic.source.connect(this.testOut)
    else this.mic.source.disconnect(this.testOut)
  }

  /** A fresh copy of the mic, for the WebRTC mic test (stop it when done). */
  micClone(): MediaStreamTrack | null {
    return this.mic?.local.clone() ?? null
  }

  /** The browser's own idea of the raw loop: mic latency + Web Audio's output buffer + the device's. */
  rawLoopbackMs(): number {
    return (this.captureLatencyMs() ?? 0) + (this.ctx.baseLatency + (this.ctx.outputLatency || 0)) * 1000
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

  private strip(id: string): Remote {
    let r = this.remotes.get(id)
    if (r) return r
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
    r = { media: null, ll: null, analyser, gain, panner, angle: Math.PI }
    this.remotes.set(id, r)
    return r
  }

  addRemote(id: string, stream: MediaStream) {
    const r = this.strip(id)
    if (r.media?.stream === stream) return
    this.dropMedia(r)
    // Chrome only feeds a remote WebRTC stream into Web Audio while a media
    // element is playing it, so there's always one (muted when Web Audio is
    // doing the playing).
    const el = new Audio()
    el.autoplay = true
    el.srcObject = stream
    if (this.outputId) void el.setSinkId?.(this.outputId).catch(() => {})
    r.media = { stream, el, source: this.ctx.createMediaStreamSource(stream) }
    this.apply(id, r)
    void el.play().catch(() => {})
  }

  removeRemote(id: string) {
    const r = this.remotes.get(id)
    if (!r) return
    this.dropMedia(r)
    if (!r.ll) this.forget(id, r)
    else this.apply(id, r)
  }

  /** The low-latency engine has a voice for them: play that instead. */
  attachLL(id: string, node: AudioNode) {
    const r = this.strip(id)
    if (r.ll === node) return
    r.ll?.disconnect()
    r.ll = node
    this.apply(id, r)
  }

  detachLL(id: string) {
    const r = this.remotes.get(id)
    if (!r?.ll) return
    r.ll.disconnect()
    r.ll = null
    if (!r.media) this.forget(id, r)
    else this.apply(id, r)
  }

  private dropMedia(r: Remote) {
    if (!r.media) return
    r.media.el.pause()
    r.media.el.srcObject = null
    r.media.source.disconnect()
    r.media = null
  }

  private forget(id: string, r: Remote) {
    this.remotes.delete(id)
    this.loudAt.delete(id)
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
    // Which source feeds the strip.
    const input: AudioNode | null = r.ll ?? r.media?.source ?? null
    r.media?.source.disconnect()
    r.ll?.disconnect()
    if (input) {
      input.connect(r.analyser)
      input.connect(r.gain)
    }
    r.gain.disconnect()
    r.panner.disconnect()
    if (r.media) {
      // The element plays only in the lowest-latency case: WebRTC audio, no panning.
      const direct = !r.ll && this.mode === 'off'
      r.media.el.muted = !direct || this.deafened
      r.media.el.volume = volume
      if (direct) return
    }
    r.gain.gain.value = volume
    if (this.mode === 'off') {
      r.gain.connect(this.master)
    } else {
      r.panner.panningModel = this.mode === 'hrtf' ? 'HRTF' : 'equalpower'
      this.position(r)
      r.gain.connect(r.panner)
      r.panner.connect(this.master)
    }
  }

  async setOutputDevice(deviceId: string) {
    this.outputId = deviceId
    const ctx = this.ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> }
    await ctx.setSinkId?.(deviceId).catch(() => {})
    for (const r of this.remotes.values()) await r.media?.el.setSinkId?.(deviceId).catch(() => {})
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
    for (const [id, r] of [...this.remotes]) {
      this.dropMedia(r)
      r.ll?.disconnect()
      this.forget(id, r)
    }
    this.mic?.local.stop()
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
