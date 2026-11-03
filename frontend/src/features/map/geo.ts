import { z } from 'zod'

import { STAGE_RAMP } from '@/features/analytics/chartTheme'

export type AreaLevel = 'municipality' | 'barangay'
export type Metric = 'trees' | 'bearing_share'
export type LonLat = { lon: number; lat: number }
export type Bounds = [number, number, number, number]

export interface AreaFigure {
  id: string
  name: string
  trees: number
  bearing_share: number | null
}

export interface LegendEntry {
  label: string
  color: string
}

export interface Classes {
  legend: LegendEntry[]
  colorOf: (figure: AreaFigure) => string | null
}

/** Same bounds as the server's LonLatField; the server has the final say. */
export const locationSchema = z.object({
  lon: z.coerce
    .number({ message: 'Enter a number.' })
    .min(116, 'Outside the Philippines.')
    .max(127, 'Outside the Philippines.'),
  lat: z.coerce
    .number({ message: 'Enter a number.' })
    .min(4, 'Outside the Philippines.')
    .max(22, 'Outside the Philippines.'),
})

const count = new Intl.NumberFormat('en-PH')

export function metricValue(figure: AreaFigure, metric: Metric): number | null {
  return metric === 'trees' ? figure.trees : figure.bearing_share
}

export function formatMetric(value: number | null, metric: Metric): string {
  if (value === null) return 'No data'
  return metric === 'trees'
    ? `${count.format(value)} trees`
    : `${String(Math.round(value * 100))}% bearing`
}

/** Lower limit of each class. Quantiles for counts, so one large town cannot wash out the rest. */
function trueBreaks(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const breaks = [0, 1, 2, 3].map((q) => sorted[Math.floor((q * sorted.length) / 4)] ?? 0)
  return [...new Set(breaks)]
}

function rampFor(classes: number): string[] {
  // Spread over the ramp so that few classes stay far apart and the top is always the darkest.
  if (classes <= 1) return [STAGE_RAMP[2]]
  return Array.from(
    { length: classes },
    (_, i) =>
      STAGE_RAMP[Math.round((i * (STAGE_RAMP.length - 1)) / (classes - 1))] ?? STAGE_RAMP[0],
  )
}

/** Ordered classes from the validated stage ramp. Share has fixed classes so maps stay comparable. */
export function classify(figures: AreaFigure[], metric: Metric): Classes {
  const values = figures.map((f) => metricValue(f, metric)).filter((v): v is number => v !== null)
  const breaks = metric === 'bearing_share' ? [0, 0.25, 0.5, 0.75] : trueBreaks(values)
  const colors = rampFor(breaks.length)

  const legend = values.length
    ? breaks.map((low, i) => {
        const next = breaks[i + 1]
        const label =
          metric === 'bearing_share'
            ? `${String(low * 100)}%–${String((next ?? 1) * 100)}%`
            : next === undefined
              ? `${count.format(low)}+`
              : `${count.format(low)}–${count.format(next - 1)}`
        return { label, color: colors[i] ?? STAGE_RAMP[0] }
      })
    : []

  return {
    legend,
    colorOf: (figure) => {
      const value = metricValue(figure, metric)
      if (value === null) return null
      let index = 0
      breaks.forEach((low, i) => {
        if (value >= low) index = i
      })
      return colors[index] ?? null
    },
  }
}

const NO_DATA = 'rgba(0,0,0,0)'

/** A MapLibre fill-color expression: match on the feature's properties.id. */
export function fillExpression(figures: AreaFigure[], classes: Classes): unknown {
  const pairs = figures.flatMap((f) => {
    const color = classes.colorOf(f)
    return color ? [f.id, color] : []
  })
  return pairs.length ? ['match', ['get', 'id'], ...pairs, NO_DATA] : NO_DATA
}

function walk(coordinates: unknown, visit: (lon: number, lat: number) => void): void {
  if (!Array.isArray(coordinates)) return
  const [first, second] = coordinates as unknown[]
  if (typeof first === 'number' && typeof second === 'number') {
    visit(first, second)
    return
  }
  coordinates.forEach((part) => walk(part, visit))
}

/** Bounding box of GeoJSON geometries' coordinates plus any points; null when there is nothing. */
export function boundsOf(geometries: unknown[], points: LonLat[] = []): Bounds | null {
  let bounds: Bounds | null = null
  const add = (lon: number, lat: number) => {
    bounds = bounds
      ? [
          Math.min(bounds[0], lon),
          Math.min(bounds[1], lat),
          Math.max(bounds[2], lon),
          Math.max(bounds[3], lat),
        ]
      : [lon, lat, lon, lat]
  }
  geometries.forEach((g) => walk((g as { coordinates?: unknown }).coordinates, add))
  points.forEach((p) => add(p.lon, p.lat))
  return bounds
}
