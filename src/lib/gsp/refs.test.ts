import { describe, expect, it } from 'vitest'
import { GspRefExhaustedError } from './errors'
import { ReferenceAllocator } from './refs'

describe('ReferenceAllocator', () => {
  it('never hands out 0, so 0 can mean "no reference"', () => {
    const refs = new ReferenceAllocator()
    for (let i = 0; i < 300; i++) {
      const ref = refs.allocate()
      expect(ref).toBeGreaterThanOrEqual(1)
      expect(ref).toBeLessThanOrEqual(255)
      refs.release(ref)
    }
  })

  it('hands out distinct codes while they are held', () => {
    const refs = new ReferenceAllocator()
    const seen = new Set<number>()
    for (let i = 0; i < refs.capacity; i++) {
      const ref = refs.allocate()
      expect(seen.has(ref)).toBe(false)
      seen.add(ref)
    }
    expect(seen.size).toBe(255)
  })

  it('throws once every code is in use', () => {
    const refs = new ReferenceAllocator()
    for (let i = 0; i < refs.capacity; i++) refs.allocate()
    expect(() => refs.allocate()).toThrow(GspRefExhaustedError)
  })

  it('does not reuse a code immediately after release', () => {
    // Notifications are unacknowledged, so a response can arrive after its
    // command timed out. Rotating allocation keeps that straggler from being
    // matched to the next request.
    const refs = new ReferenceAllocator()
    const first = refs.allocate()
    refs.release(first)
    const second = refs.allocate()
    expect(second).not.toBe(first)
  })

  it('wraps around and reuses released codes rather than running dry', () => {
    const refs = new ReferenceAllocator()
    for (let i = 0; i < 1000; i++) {
      const ref = refs.allocate()
      refs.release(ref)
    }
    expect(refs.size).toBe(0)
    expect(() => refs.allocate()).not.toThrow()
  })

  it('tracks and clears in-use codes', () => {
    const refs = new ReferenceAllocator()
    const ref = refs.allocate()
    expect(refs.has(ref)).toBe(true)
    expect(refs.size).toBe(1)
    refs.releaseAll()
    expect(refs.has(ref)).toBe(false)
    expect(refs.size).toBe(0)
  })
})
