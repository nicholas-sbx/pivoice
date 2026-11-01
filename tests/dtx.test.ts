import { describe, expect, it } from 'vitest'
import { SilenceGate } from '../src/audio/ll/gate'
import { JitterBuffer, type JitterConfig } from '../src/audio/ll/jitter'
import { bytesToPcm, decodePacket, encodePacket, pcmToBytes, type Frame } from '../src/audio/ll/packet'

/*
 * Silence suppression end to end: a voice that keeps stopping and starting,
 * through the sender's gate, packets, a network, the receiving worker's
 * checks and the jitter buffer, compared with the same voice sent with the
 * gate off. What it looks for:
 *
 * - a click at the start of a talkspurt: the largest second difference
 *   (|y[i] − 2y[i−1] + y[i−2]|, which a step shows up in and a 120–250 Hz
 *   voice barely does) around each onset, over the voice's own;
 * - latency: when each onset first gets loud at the far end, and how far
 *   behind the sender playback runs 150 ms in, against the gate off.
 */

const SR = 48000
const N = 128
const ms = (m: number) => Math.round((m * SR) / 1000)

function rng(seed: number) {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647
}

/** Room tone at −85 dBFS (under the gate's −70), and bursts of a voiced 12-harmonic tone that start at any point of a frame. */
function voice(attackMs: number, spurts = 12) {
  const rand = rng(7)
  const gaps = [600, 4000, 1200, 6000, 900, 2500]
  const talks = [500, 300, 800]
  let len = SR
  for (let i = 0; i < spurts; i++) len += ms(gaps[i % 6] + talks[i % 3]) + N
  const x = new Float32Array(len)
  const sigma = Math.pow(10, -85 / 20) * Math.sqrt(3)
  for (let i = 0; i < len; i++) x[i] = sigma * (2 * rand() - 1)
  const onsets: { at: number; end: number }[] = []
  let t = 0
  for (let s = 0; s < spurts; s++) {
    t += ms(gaps[s % 6]) + Math.floor(rand() * N)
    const d = ms(talks[s % 3])
    const a = Math.max(1, ms(attackMs))
    const r = ms(30)
    const f0 = 120 + ((s * 37) % 130)
    const ph = Array.from({ length: 12 }, () => rand() * 2 * Math.PI)
    for (let i = 0; i < d; i++) {
      const env = i < a ? 0.5 - 0.5 * Math.cos((Math.PI * i) / a) : i > d - r ? 0.5 + 0.5 * Math.cos((Math.PI * (i - (d - r))) / r) : 1
      let v = 0
      for (let h = 1; h <= 12; h++) v += Math.sin((2 * Math.PI * h * f0 * i) / SR + ph[h - 1]) / h
      x[t + i] += 0.06 * env * v
    }
    onsets.push({ at: t, end: t + d })
    t += d
  }
  return { x, onsets }
}

interface Run {
  y: Float32Array
  /** Per output block: how far behind the sender the last real sample played was. */
  delay: Float32Array
  packets: number
}

/**
 * worker.ts's sending side (gate, look-back, PCM packets with no
 * redundancy) over a path that delays packets by 2 ms plus up to
 * `jitterMs` but keeps their order, into its receiving side (frames must
 * start where the last one ended) and a playback worklet's jitter buffer
 * at LL_DEFAULTS, pulling 128-sample blocks.
 */
function run(x: Float32Array, dtx: boolean, jitterMs: number, opts: { lookBack?: boolean } = {}): Run {
  const gate = new SilenceGate()
  const rand = rng(3)
  const SKEW = 1_000_037
  const sent: { arrival: number; buf: ArrayBuffer }[] = []
  let history: Frame[] = []
  let arrival = 0
  for (let ts = 0; ts + N <= x.length; ts += N) {
    const pcm = x.slice(ts, ts + N)
    if (dtx && !gate.pass(ts, pcm, -70, 400)) continue
    const lead = dtx ? gate.lead() : []
    if (lead.length && opts.lookBack !== false) history = lead.map(l => ({ ts: l.ts, data: pcmToBytes(l.pcm) }))
    const n = opts.lookBack === false ? 0 : lead.length
    const frame = { ts, data: pcmToBytes(pcm) }
    const frames = [...history.slice(history.length - n), frame]
    history.push(frame)
    if (history.length > 2) history.shift()
    arrival = Math.max(arrival, SKEW + ts + N + 96 + Math.floor(rand() * jitterMs * 48))
    sent.push({ arrival, buf: encodePacket(frames, null, true) })
  }
  const cfg: JitterConfig = { sampleRate: SR, minMs: 0, maxMs: 80, marginMs: 3, multiplier: 1, stretch: 0.02, concealMs: 12, percentile: 99, windowSec: 3 }
  const jb = new JitterBuffer(cfg)
  const y = new Float32Array(x.length)
  const delay = new Float32Array(Math.floor(x.length / N))
  const out = new Float32Array(N)
  let nextTs = -Infinity
  let p = 0
  for (let k = 0; (k + 1) * N <= x.length; k++) {
    const now = SKEW + k * N
    for (; p < sent.length && sent[p].arrival <= now; p++) {
      for (const f of decodePacket(sent[p].buf)!.frames) {
        if (f.ts < nextTs) continue
        const pcm = bytesToPcm(f.data)
        nextTs = f.ts + pcm.length
        jb.push(f.ts, pcm, now)
      }
    }
    jb.pull(out, now)
    y.set(out, k * N)
    const st = jb.stats()
    delay[k] = st.playTs === null ? NaN : (st.atFrame - SKEW - st.playTs) / 48
  }
  return { y, delay, packets: sent.length }
}

function d2max(v: Float32Array, a: number, b: number) {
  let m = 0
  for (let i = Math.max(2, a); i < Math.min(v.length, b); i++) m = Math.max(m, Math.abs(v[i] - 2 * v[i - 1] + v[i - 2]))
  return m
}

function firstLoud(v: Float32Array, from: number, to: number) {
  for (let i = from; i < to; i++) if (Math.abs(v[i]) > 0.01) return i
  return NaN
}

interface Measured {
  /** The worst onset's largest second difference, over the voice's own. */
  step: number
  /** Samples in the talkspurts (and their hangovers) with a second difference over twice the voice's. */
  clicks: number
  /** Per onset (the first, before anything's warmed up, left out): ms from the voice getting loud to the far end getting loud, and the delay 150 ms in. */
  onset: number[]
  steady: number[]
  packets: number
}

function measure(attackMs: number, dtx: boolean, jitterMs: number, opts: { lookBack?: boolean } = {}): Measured {
  const { x, onsets } = voice(attackMs)
  const r = run(x, dtx, jitterMs, opts)
  const m: Measured = { step: 0, clicks: 0, onset: [], steady: [], packets: r.packets }
  onsets.forEach((o, i) => {
    const own = d2max(x, o.at, o.end)
    m.step = Math.max(m.step, d2max(r.y, o.at - ms(20), o.at + ms(40)) / own)
    for (let k = o.at; k < o.end + ms(400); k++) if (Math.abs(r.y[k] - 2 * r.y[k - 1] + r.y[k - 2]) > 2 * own) m.clicks++
    if (i === 0) return
    const s0 = firstLoud(x, o.at, o.end)
    m.onset.push((firstLoud(r.y, s0, s0 + ms(200)) - s0) / 48)
    m.steady.push(r.delay[Math.floor((o.at + ms(150)) / N)])
  })
  return m
}

const most = (a: number[]) => Math.max(...a)
const diff = (a: number[], b: number[]) => a.map((v, i) => v - b[i])

describe('silence suppression', () => {
  // Desktop on a wired LAN or Wi-Fi that behaves: 0–3 ms of jitter. Fast attacks (a plosive) and a slow one.
  for (const [attackMs, jitterMs] of [
    [0.3, 0],
    [3, 0],
    [15, 0],
    [3, 3]
  ]) {
    it(`starts each talkspurt without a click, and no later than with it off (attack ${attackMs} ms, jitter ${jitterMs} ms)`, () => {
      const off = measure(attackMs, false, jitterMs)
      const on = measure(attackMs, true, jitterMs)
      // Before the look-back the worst onset was 2× (slow attack) to 29–37× (fast) the voice's own.
      expect(off.step).toBeLessThan(1.2)
      expect(on.step).toBeLessThan(1.2)
      expect(on.clicks).toBe(0)
      // Not a sample later: the first loud sample, and playback 150 ms in.
      expect(most(diff(on.onset, off.onset))).toBeLessThan(0.1)
      expect(most(diff(on.steady, off.steady))).toBeLessThan(0.1)
      // And it does suppress: most of this is silence.
      expect(on.packets).toBeLessThan(off.packets * 0.4)
    })
  }

  it('starts on what the jitter was before the pause, not on nothing (jitter 0–10 ms)', () => {
    const off = measure(3, false, 10)
    const on = measure(3, true, 10)
    // Before, every sentence after a pause longer than the jitter window started on the margin alone and crackled (235 click samples here, against 23 with it off).
    expect(on.clicks).toBeLessThanOrEqual(off.clicks)
    const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length
    expect(avg(on.steady)).toBeLessThan(avg(off.steady) + 0.5)
  })

  it('still has no click from a sender without the look-back (an older app)', () => {
    const on = measure(0.3, true, 0, { lookBack: false })
    // The fade-in: a 1 ms ramp instead of a step (was 37×).
    expect(on.step).toBeLessThan(2.5)
  })
})
