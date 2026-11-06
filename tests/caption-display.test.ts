import { describe, expect, it } from 'vitest'
import { captionParts } from '../src/captions/display'

describe('caption display', () => {
  it('runs phrases together with one space, never a new line', () => {
    const parts = captionParts(['Hello there.', 'How are', 'you?'], true, 0)
    expect(parts.map(p => p.text).join('')).toBe('Hello there. How are you?')
    expect(parts.every(p => !p.text.includes('\n'))).toBe(true)
  })

  it("doesn't add a space one side already has", () => {
    expect(captionParts(['Hello. ', 'World'], false, 0).map(p => p.text).join('')).toBe('Hello. World')
    expect(captionParts(['Hello.', ' World'], false, 0).map(p => p.text).join('')).toBe('Hello. World')
  })

  it('marks only the last phrase live', () => {
    expect(captionParts(['one', 'two'], true, 0).map(p => p.live)).toEqual([false, true])
    expect(captionParts(['one', 'two'], false, 0).map(p => p.live)).toEqual([false, false])
  })

  it('fades each phrase older than the newest by the strength, with a floor', () => {
    expect(captionParts(['a', 'b', 'c'], true, 0).map(p => p.opacity)).toEqual([1, 1, 1])
    expect(captionParts(['a', 'b', 'c'], true, 0.25).map(p => p.opacity)).toEqual([0.5, 0.75, 1])
    expect(captionParts(['a', 'b', 'c', 'd', 'e'], false, 0.3).map(p => p.opacity)).toEqual([0.2, 0.2, 0.4, 0.7, 1])
  })
})
