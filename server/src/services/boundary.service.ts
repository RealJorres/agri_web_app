/**
 * Loads official municipality and barangay boundaries from a file the PAO supplies (ADR-0016). Shapes
 * only ever come from the file, and a feature is applied only when it ties to one location without
 * guessing: by PSGC code, or by name inside the requested province. Everything else is reported for a
 * person to resolve. An invalid shape is reported, not repaired (ADR-0019).
 */
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'

import proj4 from 'proj4'
import { read as readShapefile } from 'shapefile'

import { DomainError } from '../lib/errors.js'
import { isValidRing } from '../lib/geometry.js'
import { collapseSpaces, normalizeName } from '../lib/text.js'
import { inTransaction } from '../lib/transaction.js'
import { Barangay, Municipality, type MultiPolygon } from '../models/location.models.js'
import { recordAudit } from './audit.service.js'

export const LEVELS = ['municipality', 'barangay'] as const
export type BoundaryLevel = (typeof LEVELS)[number]

const SUPPORTED_SUFFIXES = new Set(['.geojson', '.json', '.shp'])
/** Every location served is in the Philippines. Anything else means a wrong coordinate system. */
const PH_BBOX = { west: 116, south: 4, east: 127, north: 22 }

// Attribute names used by the usual sources (OCHA/NAMRIA COD, GADM, PSA exports), most specific
// first. Any of them can be overridden from the command line.
const CODE_FIELDS: Record<BoundaryLevel, string[]> = {
  municipality: ['adm3_pcode', 'psgc', 'psgc_code', 'mun_code', 'code'],
  barangay: ['adm4_pcode', 'psgc', 'psgc_code', 'bgy_code', 'brgy_code', 'code'],
}
const NAME_FIELDS: Record<BoundaryLevel, string[]> = {
  municipality: ['adm3_en', 'name_2', 'municipality', 'municipal', 'mun_name', 'name'],
  barangay: ['adm4_en', 'name_3', 'barangay', 'brgy_name', 'bgy_name', 'name'],
}
const PARENT_FIELDS = ['adm3_en', 'name_2', 'municipality', 'municipal', 'mun_name']
const PROVINCE_FIELDS = ['adm2_en', 'name_1', 'province', 'prov_name']

type Position = [number, number]

interface RawFeature {
  properties: Record<string, unknown> | null
  geometry: { type: string; coordinates: unknown } | null
}

export interface BoundaryReport {
  level: BoundaryLevel
  featuresRead: number
  featuresOutsideProvince: number
  loaded: string[]
  /** In the file, but not tied to one location in the database. */
  unmatched: string[]
  ambiguous: string[]
  invalid: string[]
  /** In the database, with no shape from this file. */
  withoutShape: string[]
}

export interface LoadOptions {
  level: string
  province: string
  codeField?: string | undefined
  nameField?: string | undefined
  parentField?: string | undefined
  provinceField?: string | undefined
  dryRun?: boolean
}

interface FieldNames {
  code: string | null
  name: string | null
  parent: string | null
  province: string | null
}

function fileError(message: string): DomainError {
  return new DomainError('boundary_file', message)
}

function pick(available: Map<string, string>, explicit: string | undefined, candidates: string[]) {
  if (explicit) {
    const found = available.get(explicit.toLowerCase())
    if (found === undefined) {
      throw new DomainError('boundary_field', `The file has no attribute named '${explicit}'.`)
    }
    return found
  }
  for (const candidate of candidates) {
    const found = available.get(candidate)
    if (found !== undefined) return found
  }
  return null
}

function resolveFields(features: RawFeature[], level: BoundaryLevel, options: LoadOptions) {
  const names = [...new Set(features.flatMap((item) => Object.keys(item.properties ?? {})))]
  const available = new Map(names.map((name) => [name.toLowerCase(), name]))
  const fields: FieldNames = {
    code: pick(available, options.codeField, CODE_FIELDS[level]),
    name: pick(available, options.nameField, NAME_FIELDS[level]),
    parent: level === 'barangay' ? pick(available, options.parentField, PARENT_FIELDS) : null,
    province: pick(available, options.provinceField, PROVINCE_FIELDS),
  }
  if (fields.code === null && fields.name === null) {
    throw new DomainError(
      'boundary_field',
      `No code or name attribute recognised. The file has: ${names.join(', ')}. ` +
        'Name them with --code-field and --name-field.',
    )
  }
  return fields
}

function textOf(feature: RawFeature, name: string | null): string {
  if (name === null) return ''
  const value = feature.properties?.[name]
  if (typeof value === 'string' || typeof value === 'number') return collapseSpaces(String(value))
  return ''
}

/** 'Boac (Capital)' -> 'boac'. */
function nameKey(raw: string): string {
  return normalizeName(raw.replace(/\s*\(.*?\)\s*/gu, ' '))
}

function labelOf(feature: RawFeature, names: FieldNames): string {
  const parts = [names.name, names.parent, names.code].map((name) => textOf(feature, name))
  return parts.filter(Boolean).join(' / ') || '(unnamed feature)'
}

type Transform = (position: Position) => Position

/**
 * The projection a GeoJSON file names. WGS84 needs none, and UTM zones are built in. Anything else
 * is refused, because a guessed coordinate system would draw the shapes in the wrong place.
 */
function geojsonTransform(crs: unknown): Transform | null {
  const name = (crs as { properties?: { name?: unknown } } | undefined)?.properties?.name
  if (typeof name !== 'string' || /CRS84$|EPSG:{1,2}4326$/iu.test(name)) return null
  const utm = /EPSG:{1,2}32(6|7)(\d{2})$/iu.exec(name)
  if (!utm) {
    throw new DomainError(
      'boundary_crs',
      `The file uses the coordinate system ${name}. Convert it to WGS84 (EPSG:4326) first.`,
    )
  }
  const south = utm[1] === '7' ? ' +south' : ''
  const projection = `+proj=utm +zone=${utm[2] ?? ''}${south} +datum=WGS84 +units=m +no_defs`
  return (position) => proj4(projection, 'WGS84', position)
}

async function readFeatures(
  path: string,
): Promise<{ features: RawFeature[]; transform: Transform | null }> {
  const suffix = extname(path).toLowerCase()
  if (!SUPPORTED_SUFFIXES.has(suffix)) throw fileError('Use a GeoJSON file or a shapefile (.shp).')
  try {
    if (suffix === '.shp') {
      const base = path.slice(0, -suffix.length)
      const prj = await readFile(`${base}.prj`, 'utf8').catch(() => null)
      if (prj === null) {
        throw new DomainError(
          'boundary_crs',
          'The shapefile has no coordinate system (.prj). Ask for the complete shapefile.',
        )
      }
      const collection = await readShapefile(path, `${base}.dbf`)
      return {
        features: collection.features,
        transform: (position) => proj4(prj, 'WGS84', position),
      }
    }
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      features?: RawFeature[]
      crs?: unknown
    }
    return { features: parsed.features ?? [], transform: geojsonTransform(parsed.crs) }
  } catch (error) {
    if (error instanceof DomainError) throw error
    const code = (error as { code?: unknown }).code
    throw fileError(
      code === 'ENOENT' ? `File not found: ${basename(path)}` : `Could not read ${basename(path)}.`,
    )
  }
}

function polygonsOf(geometry: RawFeature['geometry']): Position[][][] | null {
  if (geometry?.type === 'Polygon') return [geometry.coordinates as Position[][]]
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates as Position[][][]
  return null
}

/** The feature's shape as valid WGS84 polygons inside the Philippines, or null. */
function shapeOf(feature: RawFeature, transform: Transform | null): Position[][][] | null {
  const polygons = polygonsOf(feature.geometry)
  if (!polygons || polygons.length === 0) return null
  try {
    const converted = polygons.map((rings) =>
      rings.map((ring) => ring.map((position) => (transform ? transform(position) : position))),
    )
    const { west, south, east, north } = PH_BBOX
    const inside = converted
      .flat(2)
      .every(([lon, lat]) => lon >= west && lon <= east && lat >= south && lat <= north)
    if (!inside) return null
    const valid = converted.every((rings) => rings.every(isValidRing))
    return valid ? converted : null
  } catch {
    return null
  }
}

interface Target {
  _id: string
  name: string
  normalizedName: string
  psgcCode: string | null
  isVerified?: boolean
  municipalityId?: string
}

export async function loadBoundaries(path: string, options: LoadOptions): Promise<BoundaryReport> {
  const { level: rawLevel, province, dryRun = false } = options
  if (!(LEVELS as readonly string[]).includes(rawLevel)) {
    throw new DomainError('boundary_level', `Level must be one of ${LEVELS.join(', ')}.`)
  }
  const level = rawLevel as BoundaryLevel
  const { features, transform } = await readFeatures(path)
  const names = resolveFields(features, level, options)

  return inTransaction(async (session) => {
    const towns = await Municipality.find().session(session).lean()
    const townById = new Map(towns.map((town) => [town._id, town]))
    const targets: Target[] =
      level === 'municipality' ? towns : await Barangay.find().session(session).lean()
    const displayName = (target: Target) => {
      if (level === 'municipality') return target.name
      return `${target.name}, ${townById.get(target.municipalityId ?? '')?.name ?? ''}`
    }
    const byCode = new Map<string, Target>()
    for (const row of targets) if (row.psgcCode) byCode.set(row.psgcCode, row)
    const byName = new Map<string, Target[]>()
    const addName = (key: string, target: Target) => {
      byName.set(key, [...(byName.get(key) ?? []), target])
    }
    for (const target of targets) {
      // A barangay can be found with its municipality or, when the file has no such attribute, by
      // name alone. Several hits then count as ambiguous.
      addName(`|${target.normalizedName}`, target)
      if (level === 'barangay') {
        const town = townById.get(target.municipalityId ?? '')
        addName(`${town?.normalizedName ?? ''}|${target.normalizedName}`, target)
      }
    }

    const report: BoundaryReport = {
      level,
      featuresRead: 0,
      featuresOutsideProvince: 0,
      loaded: [],
      unmatched: [],
      ambiguous: [],
      invalid: [],
      withoutShape: [],
    }
    const shapes = new Map<string, Position[][][]>()
    const matched = new Map<string, Target>()
    const namedRows = new Map<string, number>()
    const wantedProvince = normalizeName(province)

    for (const feature of features) {
      report.featuresRead += 1
      if (names.province !== null && nameKey(textOf(feature, names.province)) !== wantedProvince) {
        report.featuresOutsideProvince += 1
        continue
      }
      const label = labelOf(feature, names)
      let target = byCode.get(textOf(feature, names.code).replace(/\D/gu, ''))
      if (!target) {
        const key = `${nameKey(textOf(feature, names.parent))}|${nameKey(textOf(feature, names.name))}`
        const found = byName.get(key) ?? []
        if (found.length > 1) {
          report.ambiguous.push(label)
          continue
        }
        target = found[0]
        if (!target) {
          report.unmatched.push(label)
          continue
        }
        namedRows.set(target._id, (namedRows.get(target._id) ?? 0) + 1)
      }
      const shape = shapeOf(feature, transform)
      if (!shape) {
        report.invalid.push(label)
        continue
      }
      matched.set(target._id, target)
      shapes.set(target._id, [...(shapes.get(target._id) ?? []), ...shape])
    }

    const updates: {
      updateOne: { filter: { _id: string }; update: { $set: { boundary: MultiPolygon } } }
    }[] = []
    for (const [id, target] of matched) {
      // A file with no province attribute may hold a same-named place from another province, so
      // repeated names cannot be taken as parts of one area. Codes need no such caution.
      if (names.province === null && (namedRows.get(id) ?? 0) > 1) {
        report.ambiguous.push(displayName(target))
        continue
      }
      updates.push({
        updateOne: {
          filter: { _id: id },
          update: {
            $set: { boundary: { type: 'MultiPolygon', coordinates: shapes.get(id) ?? [] } },
          },
        },
      })
      report.loaded.push(displayName(target))
    }
    if (updates.length > 0) {
      const model = level === 'municipality' ? Municipality : Barangay
      await (model as typeof Municipality).bulkWrite(updates, { session })
    }
    report.loaded.sort()
    // Barangays created by an import may be misspellings, so only verified ones are expected.
    report.withoutShape = targets
      .filter((row) => !matched.has(row._id) && (level === 'municipality' || row.isVerified))
      .map(displayName)
      .sort()
    await recordAudit({
      actorId: null,
      action: 'boundaries.load',
      objectType: level,
      objectId: '',
      after: {
        file: basename(path),
        loaded: report.loaded.length,
        unmatched: report.unmatched.length,
        ambiguous: report.ambiguous.length,
        invalid: report.invalid.length,
      },
      session,
    })
    if (dryRun) await session.abortTransaction()
    return report
  })
}
