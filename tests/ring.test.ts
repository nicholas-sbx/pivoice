import { describe, expect, it } from 'vitest'
import { FrameRing } from '../src/audio/ll/ring'

describe('FrameRing', () => {
  it('hands frames over in order, with their timestamps', () => {
    const ring = FrameRing.create(4, 8)
    expect(ring.push(10, new Float32Array([1, 2, 3]))).toBe(true)
    expect(ring.push(13, new Float32Array([4, 5]))).toBe(true)
    const got: [number, number[]][] = []
    expect(ring.drain((ts, pcm) => got.push([ts, [...pcm]]))).toBe(2)
    expect(got).toEqual([
      [10, [1, 2, 3]],
      [13, [4, 5]]
    ])
    expect(ring.drain(() => {})).toBe(0)
  })

  it('drops the newest frame when full, and wraps around', () => {
    const ring = FrameRing.create(2, 4)
    expect(ring.push(1, new Float32Array([1]))).toBe(true)
    expect(ring.push(2, new Float32Array([2]))).toBe(true)
    expect(ring.push(3, new Float32Array([3]))).toBe(false)
    ring.drain(() => {})
    for (let i = 0; i < 10; i++) {
      expect(ring.push(100 + i, new Float32Array([i, i]))).toBe(true)
      const seen: number[] = []
      ring.drain((ts, pcm) => seen.push(ts, pcm[1]))
      expect(seen).toEqual([100 + i, i])
    }
  })

  it('rejects frames bigger than a slot', () => {
    expect(FrameRing.create(2, 4).push(0, new Float32Array(5))).toBe(false)
  })

  it('shares its memory with a second view on the same buffer', () => {
    const a = FrameRing.create(8, 16)
    const b = FrameRing.from(a.sab, 8, 16)
    a.push(42, new Float32Array([0.5]))
    const got: number[] = []
    b.drain((ts, pcm) => got.push(ts, pcm[0]))
    expect(got).toEqual([42, 0.5])
    expect(a.drain(() => {})).toBe(0)
  })
})
