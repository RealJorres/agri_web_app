import { describe, expect, it } from 'vitest'

import { STAGE_RAMP } from '@/features/analytics/chartTheme'

import {
  boundsOf,
  classify,
  fillExpression,
  formatMetric,
  locationSchema,
  type AreaFigure,
} from './geo'

const area = (id: string, trees: number, bearing_share: number | null = null): AreaFigure => ({
  id,
  name: `Synthetic ${id}`,
  trees,
  bearing_share,
})

describe('classify', () => {
  it('splits counts into four ordered classes, darkest for the largest', () => {
    const figures = [area('a', 10), area('b', 20), area('c', 30), area('d', 40)]
    const { colorOf, legend } = classify(figures, 'trees')

    expect(figures.map(colorOf)).toEqual([...STAGE_RAMP])
    expect(legend.map((l) => l.label)).toEqual(['10–19', '20–29', '30–39', '40+'])
  })

  it('merges classes when values repeat, and keeps the legend true to the data', () => {
    const figures = [area('a', 5), area('b', 5), area('c', 5), area('d', 9)]
    const { legend, colorOf } = classify(figures, 'trees')

    expect(legend).toHaveLength(2)
    expect(colorOf(area('a', 5))).toBe(STAGE_RAMP[0])
    expect(colorOf(area('d', 9))).toBe(STAGE_RAMP[3])
  })

  it('uses one mid colour when every area has the same value', () => {
    const { legend } = classify([area('a', 7), area('b', 7)], 'trees')

    expect(legend).toEqual([{ label: '7+', color: STAGE_RAMP[2] }])
  })

  it('uses fixed classes for shares, so rounds can be compared', () => {
    const { legend, colorOf } = classify([area('a', 1, 0.1), area('b', 1, 1)], 'bearing_share')

    expect(legend.map((l) => l.label)).toEqual(['0%–25%', '25%–50%', '50%–75%', '75%–100%'])
    expect(colorOf(area('c', 1, 0.5))).toBe(STAGE_RAMP[2])
    expect(colorOf(area('d', 1, 1))).toBe(STAGE_RAMP[3])
  })

  it('gives no colour and no legend when there is no data', () => {
    const none = area('a', 1, null)
    const { legend, colorOf } = classify([none], 'bearing_share')

    expect(legend).toEqual([])
    expect(colorOf(none)).toBeNull()
  })
})

describe('fillExpression', () => {
  it('matches on the id and leaves other areas transparent', () => {
    const figures = [area('a', 1), area('b', 2)]
    const expression = fillExpression(figures, classify(figures, 'trees')) as unknown[]

    expect(expression.slice(0, 2)).toEqual(['match', ['get', 'id']])
    expect(expression).toContain('a')
    expect(expression.at(-1)).toBe('rgba(0,0,0,0)')
  })

  it('is a plain colour when nothing matches (an empty match is invalid in MapLibre)', () => {
    expect(fillExpression([], classify([], 'trees'))).toBe('rgba(0,0,0,0)')
  })
})

describe('formatMetric', () => {
  it('formats values and missing data', () => {
    expect(formatMetric(1234, 'trees')).toBe('1,234 trees')
    expect(formatMetric(0.426, 'bearing_share')).toBe('43% bearing')
    expect(formatMetric(null, 'bearing_share')).toBe('No data')
  })
})

describe('boundsOf', () => {
  it('covers polygons, multipolygons and points', () => {
    const polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [121, 13],
          [122, 13],
          [122, 14],
          [121, 13],
        ],
      ],
    }
    const multi = {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [120, 12],
            [120.5, 12],
            [120.5, 12.5],
            [120, 12],
          ],
        ],
      ],
    }

    expect(boundsOf([polygon, multi], [{ lon: 123, lat: 15 }])).toEqual([120, 12, 123, 15])
  })

  it('is null when there is nothing to fit', () => {
    expect(boundsOf([], [])).toBeNull()
  })
})

describe('locationSchema', () => {
  it('accepts typed numbers inside the Philippines', () => {
    expect(locationSchema.parse({ lon: '121.9', lat: '13.4' })).toEqual({ lon: 121.9, lat: 13.4 })
  })

  it('refuses places outside the Philippines and non-numbers', () => {
    expect(locationSchema.safeParse({ lon: 10, lat: 50 }).success).toBe(false)
    expect(locationSchema.safeParse({ lon: 'abc', lat: 13 }).success).toBe(false)
    expect(locationSchema.safeParse({ lon: undefined, lat: undefined }).success).toBe(false)
  })
})
