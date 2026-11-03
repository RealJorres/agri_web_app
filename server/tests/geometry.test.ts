import { describe, expect, it } from 'vitest'

import { isValidRing } from '../src/lib/geometry.js'

const SQUARE = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
  [0, 0],
]

function circle(points: number): number[][] {
  const ring: number[][] = []
  for (let i = 0; i < points; i += 1) {
    const angle = (2 * Math.PI * i) / points
    ring.push([Math.cos(angle), Math.sin(angle)])
  }
  ring.push(ring[0] as number[])
  return ring
}

describe('isValidRing', () => {
  it.each([
    ['a square', SQUARE],
    [
      'a triangle',
      [
        [0, 0],
        [1, 0],
        [0, 1],
        [0, 0],
      ],
    ],
    [
      'a repeated point',
      [
        [0, 0],
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0],
      ],
    ],
    [
      'an inward corner',
      [
        [0, 0],
        [2, 0],
        [1, 1],
        [2, 2],
        [0, 2],
        [0, 0],
      ],
    ],
  ])('accepts %s', (_name, ring) => {
    expect(isValidRing(ring)).toBe(true)
  })

  it.each([
    [
      'a bowtie',
      [
        [0, 0],
        [1, 1],
        [1, 0],
        [0, 1],
        [0, 0],
      ],
    ],
    [
      'an open ring',
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
    ],
    [
      'too few points',
      [
        [0, 0],
        [1, 0],
        [0, 0],
      ],
    ],
    ['nothing', []],
    [
      'a ring touching itself',
      [
        [0, 0],
        [2, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0],
      ],
    ],
    [
      'a ring doubling back on itself',
      [
        [0, 0],
        [2, 0],
        [1, 0],
        [3, 0],
        [3, 1],
        [0, 0],
      ],
    ],
  ])('refuses %s', (_name, ring) => {
    expect(isValidRing(ring)).toBe(false)
  })

  it('handles a coastline-sized ring quickly, and still finds a crossing in it', () => {
    const ring = circle(50_000)
    const started = Date.now()
    expect(isValidRing(ring)).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)

    const crossed = [...ring]
    // Two far-apart points swap, so the outline crosses itself.
    const [a, b] = [crossed[10], crossed[25_000]]
    crossed[10] = b as number[]
    crossed[25_000] = a as number[]
    expect(isValidRing(crossed)).toBe(false)
  })
})
