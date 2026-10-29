import { describe, expect, it } from 'vitest'
import { LL_DEFAULTS, frameSamples, llDefaults, sanitizeLL } from '../src/audio/ll/config'
import { JitterBuffer, type JitterConfig } from '../src/audio/ll/jitter'
import { PING, PONG, Unwrapper, bytesToPcm, decodePacket, decodePing, encodePacket, encodePing, pcmToBytes } from '../src/audio/ll/packet'

describe('packets', () => {
  it('round-trips frames and the capture stamp', () => {
    const frames = [
      { ts: 0xffff_ff00, data: new Uint8Array([1, 2, 3]) },
      { ts: 16, data: new Uint8Array([9]) }
    ]
    const p = decodePacket(encodePacket(frames, 1234.5))!
    expect(p.captureMs).toBe(1234.5)
    expect(p.frames.map(f => [f.ts, [...f.data]])).toEqual([
      [0xffff_ff00, [1, 2, 3]],
      [16, [9]]
    ])
    expect(decodePacket(encodePacket(frames))!.captureMs).toBeNull()
  })

  it('tells pings from audio packets', () => {
    expect(decodePing(encodePing(PING, 1234.5))).toEqual({ kind: PING, sentMs: 1234.5 })
    expect(decodePing(encodePing(PONG, 7))!.kind).toBe(PONG)
    // Neither side mistakes one for the other, and old clients drop pings as a bad version.
    expect(decodePacket(encodePing(PING, 1))).toBeNull()
    expect(decodePing(encodePacket([{ ts: 7, data: new Uint8Array(1) }]))).toBeNull()
  })

  it('flags raw PCM and round-trips its samples', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25])
    const p = decodePacket(encodePacket([{ ts: 7, data: pcmToBytes(samples) }], null, true))!
    expect(p.pcm).toBe(true)
    const back = bytesToPcm(p.frames[0].data)
    back.forEach((v, i) => expect(v).toBeCloseTo(samples[i], 4))
    expect(decodePacket(encodePacket([{ ts: 7, data: new Uint8Array(1) }]))!.pcm).toBe(false)
  })

  it('rejects truncated or foreign data', () => {
    const buf = encodePacket([{ ts: 1, data: new Uint8Array(10) }])
    expect(decodePacket(buf.slice(0, buf.byteLength - 1))).toBeNull()
    expect(decodePacket(new Uint8Array([2, 0, 0]).buffer)).toBeNull()
    expect(decodePacket(new ArrayBuffer(1))).toBeNull()
  })

  it('unwraps the 32-bit sample clock', () => {
    const u = new Unwrapper()
    expect(u.unwrap(0xffff_ff00)).toBe(0xffff_ff00)
    expect(u.unwrap(0x100)).toBe(0x1_0000_0100)
    // A late frame from before the wrap still lands before it.
    expect(u.unwrap(0xffff_ff80)).toBe(0xffff_ff80)
    expect(u.unwrap(0x200)).toBe(0x1_0000_0200)
  })
})

describe('config', () => {
  it('fills in defaults and clamps', () => {
    expect(sanitizeLL(null, true)).toEqual(LL_DEFAULTS)
    // Off in a browser, on in the app.
    expect(sanitizeLL(null, false)).toEqual({ ...LL_DEFAULTS, enabled: false })
    expect(llDefaults(true).enabled).toBe(true)
    // Settings saved before rev 3 reset to the defaults.
    expect(sanitizeLL({ enabled: true, frameMs: 2.5, dtxThresholdDb: -55 }, true)).toEqual(LL_DEFAULTS)
    // In the app, on by default since rev 3: an "off" saved before then was just the old default.
    expect(sanitizeLL({ rev: 2, enabled: false }, true).enabled).toBe(true)
    expect(sanitizeLL({ rev: 3, enabled: false }, true).enabled).toBe(false)
    // In a browser, off by default since rev 4: an "on" saved at rev 3 was the old default, but its tuning stays.
    const web3 = sanitizeLL({ rev: 3, enabled: true, frameMs: 10 }, false)
    expect(web3.enabled).toBe(false)
    expect(web3.frameMs).toBe(10)
    expect(sanitizeLL({ rev: LL_DEFAULTS.rev, enabled: true }, false).enabled).toBe(true)
    const c = sanitizeLL({ rev: LL_DEFAULTS.rev, frameMs: 2.5, bitrateKbps: 9999, minBufferMs: 50, maxBufferMs: 20, redundancy: 7, application: 'nope' }, true)
    expect(c.frameMs).toBe(2.5)
    expect(c.bitrateKbps).toBe(256)
    expect(c.maxBufferMs).toBe(50)
    expect(c.redundancy).toBe(LL_DEFAULTS.redundancy)
    expect(c.application).toBe('lowdelay')
    expect(frameSamples(2.5)).toBe(120)
  })
})

/**
 * A sender making 5 ms frames whose samples count up (sample value = its
 * sender timestamp), so whatever comes out says exactly which moment of
 * the sender's audio is playing and how late.
 */
function simulate(opts: {
  seconds: number
  jitterMs?: number
  lose?: (k: number) => boolean
  silent?: (k: number) => boolean
  cfg?: Partial<JitterConfig>
  seed?: number
}) {
  const sr = 48000
  const F = 240
  const cfg: JitterConfig = {
    sampleRate: sr,
    minMs: 0,
    maxMs: 80,
    marginMs: 2,
    multiplier: 1.2,
    stretch: 0.02,
    concealMs: 12,
    percentile: 99,
    windowSec: 2,
    ...opts.cfg
  }
  const jb = new JitterBuffer(cfg)
  let seed = opts.seed ?? 1
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const SKEW = 1_000_000 // the two clocks start far apart; only differences matter
  const pending: { arrival: number; ts: number; pcm: Float32Array }[] = []
  const total = opts.seconds * sr
  // The sender runs a little past the end so the receiver never runs dry at the finish.
  for (let k = 0; k * F < total + sr / 10; k++) {
    if (opts.lose?.(k) || opts.silent?.(k)) continue
    const ts = k * F
    const pcm = new Float32Array(F)
    for (let j = 0; j < F; j++) pcm[j] = ts + j
    // Captured over the frame, 2 ms on the wire, plus jitter.
    const arrival = SKEW + ts + F + 96 + Math.floor(rand() * (opts.jitterMs ?? 0) * 48)
    pending.push({ arrival, ts, pcm })
  }
  pending.sort((a, b) => a.arrival - b.arrival)
  const delays: number[] = []
  const out = new Float32Array(128)
  let sum = 0
  let samples = 0
  let silentSamples = 0
  let p = 0
  for (let now = SKEW; now < SKEW + total; now += 128) {
    while (p < pending.length && pending[p].arrival <= now) {
      jb.push(pending[p].ts, pending[p].pcm, pending[p].arrival)
      p++
    }
    jb.pull(out, now)
    for (let i = 0; i < 128; i++) {
      if (out[i] > 0) {
        delays.push((now + i - SKEW - out[i]) / 48)
        sum += 1
      } else silentSamples++
      samples++
    }
  }
  const stats = jb.stats()
  const settled = delays.slice(Math.floor(delays.length / 2))
  const mean = settled.reduce((a, b) => a + b, 0) / settled.length
  return { stats, meanDelayMs: mean, delays, played: sum / samples, silentSamples, jb }
}

describe('JitterBuffer', () => {
  it('plays a clean stream with almost no buffering', () => {
    const r = simulate({ seconds: 4 })
    // Capture (5 ms) + wire (2 ms) + one 128-sample block (2.7 ms) + the 2 ms margin, and nothing else.
    expect(r.meanDelayMs).toBeGreaterThan(5 + 2 + 2.6)
    expect(r.meanDelayMs).toBeLessThan(5 + 2 + 2.7 + 2 + 0.5)
    expect(r.stats.concealedPct).toBe(0)
    expect(r.stats.late).toBe(0)
    expect(r.played).toBeGreaterThan(0.98)
  })

  it('grows to cover the jitter, and not much more', () => {
    const r = simulate({ seconds: 6, jitterMs: 10 })
    expect(r.stats.jitterMs).toBeGreaterThan(8)
    expect(r.stats.jitterMs).toBeLessThan(10.5)
    expect(r.stats.targetMs).toBeCloseTo(r.stats.jitterMs * 1.2 + 2, 5)
    // Base path + target, give or take the steering.
    expect(r.meanDelayMs).toBeLessThan(7 + 2.7 + r.stats.targetMs + 2)
    expect(r.played).toBeGreaterThan(0.97)
  })

  it('keeps the gaps rare on a jittery network', () => {
    const r = simulate({ seconds: 8, jitterMs: 15 })
    expect(r.stats.concealedPct).toBeLessThan(1)
  })

  it('waits for a pause to shed a little extra buffering, instead of speeding up through speech', () => {
    // Someone talking steadily, on time; then the buffer's target drops by 10 ms (the network calmed down).
    const cfg: JitterConfig = { sampleRate: 48000, minMs: 30, maxMs: 80, marginMs: 2, multiplier: 1.2, stretch: 0.02, concealMs: 12, percentile: 99, windowSec: 2 }
    const jb = new JitterBuffer(cfg)
    const rate = () => (jb as unknown as { rate: number }).rate
    const out = new Float32Array(128)
    let ts = 0
    let now = 1_000_000
    const run = (seconds: number, level: number, watch?: (r: number) => void) => {
      for (const end = now + seconds * 48000; now < end; now += 128) {
        while (ts < now - 1_000_000 + 480) {
          jb.push(ts, new Float32Array(240).fill(level), 1_000_000 + ts + 240 + 96)
          ts += 240
        }
        jb.pull(out, now)
        watch?.(rate())
      }
    }
    run(2, 0.3) // talking
    jb.configure({ minMs: 20 })
    let most = 0
    run(1, 0.3, r => (most = Math.max(most, Math.abs(r - 1))))
    // Still talking: the speed (and so the pitch) didn't move.
    expect(most).toBe(0)
    // A pause (room tone): now it sheds the extra, faster than real time.
    let fastest = 1
    run(1, 0.0005, r => (fastest = Math.max(fastest, r)))
    expect(fastest).toBeGreaterThan(1.005)
  })

  it('plays samples in order, without jumps, once settled', () => {
    const r = simulate({ seconds: 4, jitterMs: 4 })
    const tail = r.delays.slice(-48000)
    for (let i = 1; i < tail.length; i++) expect(Math.abs(tail[i] - tail[i - 1])).toBeLessThan(0.05)
  })

  it('conceals a lost frame and carries on', () => {
    const r = simulate({ seconds: 3, lose: k => k === 300 })
    expect(r.played).toBeGreaterThan(0.97)
    expect(r.stats.concealedPct).toBeGreaterThan(0)
    const after = r.delays.slice(-1000)
    const bad = after.filter(d => !(d > 9 && d < 13))
    expect(bad.slice(0, 5)).toEqual([])
  })

  it('goes quiet through a silence (DTX) and starts the next talkspurt fresh', () => {
    // Talk for 1 s, nothing for 1 s, talk for 1 s.
    const r = simulate({ seconds: 3, silent: k => k >= 200 && k < 400 })
    expect(r.silentSamples).toBeGreaterThan(40000)
    // Running out at the end of a sentence isn't a loss.
    expect(r.stats.concealedPct).toBe(0)
    const last = r.delays.slice(-1000)
    expect(last.filter(d => !(d > 9 && d < 13)).slice(0, 5)).toEqual([])
  })

  it('respects the minimum buffer', () => {
    const r = simulate({ seconds: 3, cfg: { minMs: 30 } })
    expect(r.stats.targetMs).toBe(30)
    expect(r.meanDelayMs).toBeGreaterThan(30 + 7 + 2.6)
    expect(r.meanDelayMs).toBeLessThan(30 + 7 + 2.7 + 1)
  })
})
