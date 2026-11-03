/**
 * Map reads (ADR-0016). Boundaries are public geography, so they are reference data, not scoped.
 * The figures drawn on them come from the scoped analytics endpoints.
 */
import { simplify } from '@turf/simplify'

import { Barangay, Municipality, type MultiPolygon } from '../models/location.models.js'

/** About 20 m: invisible at the zooms the map is read at, and it keeps responses small. */
const SIMPLIFY_TOLERANCE_DEG = 0.0002
const COORDINATE_DECIMALS = 5

export const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

const DEFAULTS = {
  tileUrl: DEFAULT_TILE_URL,
  tileAttribution: '© OpenStreetMap contributors',
  center: [121.97, 13.4],
  zoom: 10,
}

function parseCenter(raw: string | undefined): number[] {
  const parts = (raw ?? '').split(',').map(Number)
  return parts.length === 2 && parts.every(Number.isFinite) ? parts : DEFAULTS.center
}

export async function mapConfig() {
  const hasShape = { boundary: { $ne: null } }
  const [municipalityBoundaries, barangayBoundaries] = await Promise.all([
    Municipality.countDocuments(hasShape),
    Barangay.countDocuments(hasShape),
  ])
  const zoom = Number(process.env.MAP_DEFAULT_ZOOM)
  return {
    tile_url: process.env.MAP_TILE_URL ?? DEFAULTS.tileUrl,
    tile_attribution: process.env.MAP_TILE_ATTRIBUTION ?? DEFAULTS.tileAttribution,
    center: parseCenter(process.env.MAP_DEFAULT_CENTER),
    zoom: Number.isFinite(zoom) && process.env.MAP_DEFAULT_ZOOM ? zoom : DEFAULTS.zoom,
    municipality_boundaries: municipalityBoundaries,
    barangay_boundaries: barangayBoundaries,
  }
}

function roundCoordinates(value: unknown): unknown {
  if (typeof value === 'number') return Number(value.toFixed(COORDINATE_DECIMALS))
  return Array.isArray(value) ? value.map(roundCoordinates) : value
}

function simplified(boundary: MultiPolygon): unknown {
  const reduced = simplify(boundary as never, {
    tolerance: SIMPLIFY_TOLERANCE_DEG,
    highQuality: false,
    mutate: false,
  }) as unknown as MultiPolygon
  return { type: reduced.type, coordinates: roundCoordinates(reduced.coordinates) }
}

/**
 * A GeoJSON FeatureCollection. The id is in properties, because MapLibre needs numeric top-level
 * feature ids and joins on properties.id instead.
 */
export async function boundaryFeatures({
  level,
  municipality,
}: {
  level: 'municipality' | 'barangay'
  municipality?: string | undefined
}) {
  const hasShape = { boundary: { $ne: null } }
  const rows =
    level === 'barangay'
      ? await Barangay.find({
          ...hasShape,
          ...(municipality ? { municipalityId: municipality } : {}),
        })
          .select('+boundary name')
          .lean()
      : await Municipality.find({ ...hasShape, ...(municipality ? { _id: municipality } : {}) })
          .select('+boundary name')
          .lean()
  return {
    type: 'FeatureCollection',
    features: rows.map((row) => ({
      type: 'Feature',
      properties: { id: row._id, name: row.name },
      geometry: simplified(row.boundary as MultiPolygon),
    })),
  }
}
