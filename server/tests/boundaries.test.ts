/** The boundary loader and map endpoints. Files are synthetic squares with made-up codes. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import request from 'supertest'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { Role } from '../src/lib/roles.js'
import { AuditLog } from '../src/models/auditLog.model.js'
import { Barangay, Municipality, type MultiPolygon } from '../src/models/location.models.js'
import { boundaryFeatures, mapConfig } from '../src/selectors/map.selectors.js'
import { loadBoundaries, type LoadOptions } from '../src/services/boundary.service.js'
import { contractProblems } from './support/contract.js'
import { makeBarangay, makeMunicipality, signedIn, userWithRole } from './support/factories.js'

const app = createApp({ production: false })
const folder = mkdtempSync(join(tmpdir(), 'boundaries-'))
let fileNumber = 0

afterAll(() => {
  rmSync(folder, { recursive: true, force: true })
})

beforeEach(async () => {
  await Promise.all([Municipality.collection.deleteMany({}), Barangay.collection.deleteMany({})])
})

function square(lon = 121.9, lat = 13.4, size = 0.1): number[][][] {
  return [
    [
      [lon, lat],
      [lon + size, lat],
      [lon + size, lat + size],
      [lon, lat + size],
      [lon, lat],
    ],
  ]
}

function feature(properties: object, coordinates = square(), type = 'Polygon') {
  return { type: 'Feature', properties, geometry: { type, coordinates } }
}

function write(features: object[], extra: object = {}): string {
  fileNumber += 1
  const path = join(folder, `shapes-${String(fileNumber)}.geojson`)
  writeFileSync(path, JSON.stringify({ type: 'FeatureCollection', features, ...extra }))
  return path
}

function load(path: string, options: Partial<LoadOptions> = {}) {
  return loadBoundaries(path, {
    level: 'municipality',
    province: 'Synthetic Province',
    ...options,
  })
}

async function shapeOfTown(id: string): Promise<MultiPolygon | null | undefined> {
  return (await Municipality.findOne({ _id: id }).select('+boundary').lean())?.boundary
}

describe('loadBoundaries', () => {
  it('loads by name, and ignores a parenthetical', async () => {
    const town = await makeMunicipality('Alpha Town')
    const report = await load(
      write([feature({ ADM3_EN: 'Alpha Town (Capital)', ADM2_EN: 'Synthetic Province' })]),
    )
    expect(report.loaded).toEqual(['Alpha Town'])
    expect((await shapeOfTown(town._id))?.type).toBe('MultiPolygon')
  })

  it('prefers a code match over a different name', async () => {
    const town = await makeMunicipality('Alpha Town')
    await Municipality.updateOne({ _id: town._id }, { psgcCode: '9904001000' })
    const report = await load(write([feature({ PSGC: '9904001000', NAME: 'Spelled Differently' })]))
    expect(report.loaded).toEqual(['Alpha Town'])
  })

  it('ignores other provinces, even with the same name', async () => {
    const town = await makeMunicipality('Alpha Town')
    const report = await load(
      write([
        feature({ ADM3_EN: 'Alpha Town', ADM2_EN: 'Another Province' }, square(120)),
        feature({ ADM3_EN: 'Alpha Town', ADM2_EN: 'Synthetic Province' }),
      ]),
    )
    expect(report.featuresOutsideProvince).toBe(1)
    expect((await shapeOfTown(town._id))?.coordinates[0]?.[0]?.[0]?.[0]).toBeCloseTo(121.9)
  })

  it('merges repeated rows of one province into one area', async () => {
    const town = await makeMunicipality('Alpha Town')
    await load(
      write([
        feature({ ADM3_EN: 'Alpha Town', ADM2_EN: 'Synthetic Province' }),
        feature({ ADM3_EN: 'Alpha Town', ADM2_EN: 'Synthetic Province' }, square(122.2)),
      ]),
    )
    expect((await shapeOfTown(town._id))?.coordinates).toHaveLength(2)
  })

  it('accepts a MultiPolygon', async () => {
    const town = await makeMunicipality('Alpha Town')
    await load(
      write([feature({ NAME: 'Alpha Town' }, [square(), square(122.2)] as never, 'MultiPolygon')]),
    )
    expect((await shapeOfTown(town._id))?.coordinates).toHaveLength(2)
  })

  it('does not guess at a repeated name with no province attribute', async () => {
    const town = await makeMunicipality('Alpha Town')
    const report = await load(
      write([feature({ NAME: 'Alpha Town' }), feature({ NAME: 'Alpha Town' }, square(120))]),
    )
    expect(await shapeOfTown(town._id)).toBeNull()
    expect(report.ambiguous).toEqual(['Alpha Town'])
  })

  it('uses the parent to separate same-named barangays', async () => {
    const alpha = await makeMunicipality('Alpha Town')
    const beta = await makeMunicipality('Beta Town')
    const first = await makeBarangay(alpha._id, 'Poblacion')
    const second = await makeBarangay(beta._id, 'Poblacion')
    const report = await load(
      write([
        feature({ ADM4_EN: 'Poblacion', ADM3_EN: 'Beta Town', ADM2_EN: 'Synthetic Province' }),
      ]),
      { level: 'barangay' },
    )
    expect(report.loaded).toEqual(['Poblacion, Beta Town'])
    const shape = async (id: string) =>
      (await Barangay.findOne({ _id: id }).select('+boundary').lean())?.boundary
    expect(await shape(first._id)).toBeNull()
    expect(await shape(second._id)).not.toBeNull()
  })

  it('treats a barangay name alone as ambiguous across municipalities', async () => {
    await makeBarangay((await makeMunicipality('Alpha Town'))._id, 'Poblacion')
    await makeBarangay((await makeMunicipality('Beta Town'))._id, 'Poblacion')
    const report = await load(write([feature({ BARANGAY: 'Poblacion' })]), { level: 'barangay' })
    expect(report.loaded).toEqual([])
    expect(report.ambiguous).toEqual(['Poblacion'])
  })

  it('reports what did not match, and what has no shape', async () => {
    await makeMunicipality('Alpha Town')
    const report = await load(write([feature({ NAME: 'Nowhere' })]))
    expect(report.unmatched).toEqual(['Nowhere'])
    expect(report.withoutShape).toContain('Alpha Town')
  })

  it.each([
    ['outside the Philippines', square(10, 50)],
    ['with swapped coordinates', square(13.4, 121.9)],
  ])('refuses a shape %s', async (_name, coordinates) => {
    const town = await makeMunicipality('Alpha Town')
    const report = await load(write([feature({ NAME: 'Alpha Town' }, coordinates)]))
    expect(report.invalid).toEqual(['Alpha Town'])
    expect(await shapeOfTown(town._id)).toBeNull()
  })

  it('reports a self-intersecting shape, and does not repair it', async () => {
    const town = await makeMunicipality('Alpha Town')
    const bowtie = [
      [
        [121.9, 13.4],
        [122.0, 13.5],
        [122.0, 13.4],
        [121.9, 13.5],
        [121.9, 13.4],
      ],
    ]
    const report = await load(write([feature({ NAME: 'Alpha Town' }, bowtie)]))
    expect(report.invalid).toEqual(['Alpha Town'])
    expect(await shapeOfTown(town._id)).toBeNull()
  })

  it('converts UTM coordinates to WGS84', async () => {
    const town = await makeMunicipality('Alpha Town')
    const [x, y] = [380000, 1481000]
    const coordinates = [
      [
        [x, y],
        [x + 1000, y],
        [x + 1000, y + 1000],
        [x, y + 1000],
        [x, y],
      ],
    ]
    const report = await load(
      write([feature({ NAME: 'Alpha Town' }, coordinates)], {
        crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::32651' } },
      }),
    )
    expect(report.loaded).toEqual(['Alpha Town'])
    const [lon, lat] = (await shapeOfTown(town._id))?.coordinates[0]?.[0]?.[0] ?? []
    expect(lon).toBeGreaterThan(121.5)
    expect(lon).toBeLessThan(122.5)
    expect(lat).toBeGreaterThan(13)
    expect(lat).toBeLessThan(13.8)
  })

  it('refuses a coordinate system it cannot be sure of', async () => {
    await expect(
      load(
        write([feature({ NAME: 'Alpha Town' })], {
          crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3123' } },
        }),
      ),
    ).rejects.toMatchObject({ code: 'boundary_crs' })
  })

  it('changes nothing on a dry run, and writes no audit entry', async () => {
    const town = await makeMunicipality('Alpha Town')
    const before = await AuditLog.countDocuments({ action: 'boundaries.load' })
    const report = await load(write([feature({ NAME: 'Alpha Town' })]), { dryRun: true })
    expect(report.loaded).toEqual(['Alpha Town'])
    expect(await shapeOfTown(town._id)).toBeNull()
    expect(await AuditLog.countDocuments({ action: 'boundaries.load' })).toBe(before)
  })

  it('is audited without coordinates', async () => {
    await makeMunicipality('Alpha Town')
    await load(write([feature({ NAME: 'Alpha Town' })]))
    const entry = await AuditLog.findOne({ action: 'boundaries.load' })
      .sort({ createdAt: -1 })
      .lean()
    expect((entry?.after as { loaded: number }).loaded).toBe(1)
    expect(JSON.stringify(entry?.after)).not.toContain('coordinates')
  })

  it.each([
    [{ level: 'province' }, 'boundary_level'],
    [{ nameField: 'MISSING' }, 'boundary_field'],
  ])('refuses bad options (%j)', async (options, code) => {
    await expect(load(write([feature({ NAME: 'Alpha Town' })]), options)).rejects.toMatchObject({
      code,
    })
  })

  it('names the attributes a file has, when none is usable', async () => {
    await expect(load(write([feature({ WIDGET: 'x' })]))).rejects.toThrow('WIDGET')
  })

  it('refuses a missing file, a bad type, and bad JSON', async () => {
    await expect(load(join(folder, 'missing.geojson'))).rejects.toMatchObject({
      code: 'boundary_file',
    })
    const csv = join(folder, 'shapes.csv')
    writeFileSync(csv, 'a,b\n')
    await expect(load(csv)).rejects.toMatchObject({ code: 'boundary_file' })
    const bad = join(folder, 'bad.geojson')
    writeFileSync(bad, '{nope')
    await expect(load(bad)).rejects.toMatchObject({ code: 'boundary_file' })
  })
})

describe('shapefiles', () => {
  /** A minimal one-polygon shapefile, written by hand so a test controls every part. */
  function writeShapefile(withPrj: boolean): string {
    fileNumber += 1
    const base = join(folder, `shp-${String(fileNumber)}`)
    const ring = square()[0] as number[][]
    const contentBytes = 44 + 4 + ring.length * 16
    const recordBytes = 8 + contentBytes
    const shp = Buffer.alloc(100 + recordBytes)
    shp.writeInt32BE(9994, 0)
    shp.writeInt32BE((100 + recordBytes) / 2, 24)
    shp.writeInt32LE(1000, 28)
    shp.writeInt32LE(5, 32)
    shp.writeDoubleLE(121.9, 36)
    shp.writeDoubleLE(13.4, 44)
    shp.writeDoubleLE(122, 52)
    shp.writeDoubleLE(13.5, 60)
    let at = 100
    shp.writeInt32BE(1, at)
    shp.writeInt32BE(contentBytes / 2, at + 4)
    at += 8
    shp.writeInt32LE(5, at)
    shp.writeDoubleLE(121.9, at + 4)
    shp.writeDoubleLE(13.4, at + 12)
    shp.writeDoubleLE(122, at + 20)
    shp.writeDoubleLE(13.5, at + 28)
    shp.writeInt32LE(1, at + 36)
    shp.writeInt32LE(ring.length, at + 40)
    shp.writeInt32LE(0, at + 44)
    at += 48
    for (const [lon, lat] of ring) {
      shp.writeDoubleLE(lon ?? 0, at)
      shp.writeDoubleLE(lat ?? 0, at + 8)
      at += 16
    }
    writeFileSync(`${base}.shp`, shp)

    const name = 'Alpha Town'.padEnd(20)
    const dbf = Buffer.alloc(32 + 32 + 1 + 1 + 20 + 1)
    dbf.writeUInt8(3, 0)
    dbf.writeUInt32LE(1, 4)
    dbf.writeUInt16LE(32 + 32 + 1, 8)
    dbf.writeUInt16LE(1 + 20, 10)
    dbf.write('NAME', 32, 'ascii')
    dbf.write('C', 32 + 11, 'ascii')
    dbf.writeUInt8(20, 32 + 16)
    dbf.writeUInt8(0x0d, 64)
    dbf.write(' ', 65, 'ascii')
    dbf.write(name, 66, 'ascii')
    dbf.writeUInt8(0x1a, 86)
    writeFileSync(`${base}.dbf`, dbf)
    if (withPrj) {
      writeFileSync(
        `${base}.prj`,
        'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],' +
          'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]',
      )
    }
    return `${base}.shp`
  }

  it('loads one with a coordinate system', async () => {
    const town = await makeMunicipality('Alpha Town')
    const report = await load(writeShapefile(true))
    expect(report.loaded).toEqual(['Alpha Town'])
    const [lon, lat] = (await shapeOfTown(town._id))?.coordinates[0]?.[0]?.[0] ?? []
    expect(lon).toBeCloseTo(121.9, 5)
    expect(lat).toBeCloseTo(13.4, 5)
  })

  it('refuses one with no .prj', async () => {
    await expect(load(writeShapefile(false))).rejects.toMatchObject({ code: 'boundary_crs' })
  })
})

describe('list queries', () => {
  it('leave the large boundary out unless they ask', async () => {
    const town = await makeMunicipality('Alpha Town')
    await load(write([feature({ NAME: 'Alpha Town' })]))
    const plain = await Municipality.findOne({ _id: town._id }).lean()
    expect(plain).not.toHaveProperty('boundary')
  })

  it('keep a boundary when a row is saved without it', async () => {
    const town = await makeMunicipality('Alpha Town')
    await load(write([feature({ NAME: 'Alpha Town' })]))
    const row = await Municipality.findOne({ _id: town._id })
    if (!row) throw new Error('no row')
    row.psgcCode = '9904001000'
    await row.save()
    expect(await shapeOfTown(town._id)).not.toBeNull()
  })
})

describe('the map endpoints', () => {
  it('return GeoJSON for what has a shape, with rounded coordinates', async () => {
    const town = await makeMunicipality('Alpha Town')
    await makeMunicipality('No Shape Yet')
    await load(write([feature({ NAME: 'Alpha Town' }, square(121.123456789, 13.123456789))]))
    const viewer = await userWithRole(Role.VIEWER)
    const response = await signedIn(request(app).get('/api/v1/map/boundaries'), viewer)
    expect(response.status).toBe(200)
    expect(contractProblems('/api/v1/map/boundaries', 'get', 200, response.body)).toEqual([])
    const body = response.body as {
      type: string
      features: { properties: object; geometry: { type: string; coordinates: number[][][][] } }[]
    }
    expect(body.type).toBe('FeatureCollection')
    expect(body.features.map((row) => row.properties)).toEqual([
      { id: town._id, name: 'Alpha Town' },
    ])
    expect(body.features[0]?.geometry.coordinates[0]?.[0]?.[0]?.[0]).toBe(121.12346)
  })

  it('simplify shapes, keeping them closed', async () => {
    await makeMunicipality('Alpha Town')
    const ring: number[][] = []
    for (let i = 0; i < 400; i += 1) {
      const angle = (2 * Math.PI * i) / 400
      ring.push([122 + 0.1 * Math.cos(angle), 13.4 + 0.1 * Math.sin(angle)])
    }
    ring.push(ring[0] as number[])
    await load(write([feature({ NAME: 'Alpha Town' }, [ring])]))
    const { features } = await boundaryFeatures({ level: 'municipality' })
    const geometry = features[0]?.geometry as { coordinates: number[][][][] }
    const drawn = geometry.coordinates[0]?.[0] ?? []
    expect(drawn.length).toBeLessThan(ring.length)
    expect(drawn.at(0)).toEqual(drawn.at(-1))
  })

  it('filter barangays by municipality', async () => {
    const wantedTown = await makeMunicipality('Wanted Town')
    const otherTown = await makeMunicipality('Other Town')
    await makeBarangay(wantedTown._id, 'Wanted')
    await makeBarangay(otherTown._id, 'Elsewhere')
    await load(
      write([
        feature({ ADM4_EN: 'Wanted', ADM3_EN: 'Wanted Town' }),
        feature({ ADM4_EN: 'Elsewhere', ADM3_EN: 'Other Town' }, square(122.2)),
      ]),
      { level: 'barangay' },
    )
    const { features } = await boundaryFeatures({
      level: 'barangay',
      municipality: wantedTown._id,
    })
    expect(features.map((row) => row.properties.name)).toEqual(['Wanted'])
  })

  it('report the tile source and what has been loaded', async () => {
    await makeMunicipality('Alpha Town')
    await load(write([feature({ NAME: 'Alpha Town' })]))
    process.env.MAP_TILE_URL = 'https://tiles.example.test/{z}/{x}/{y}.png'
    const config = await mapConfig()
    delete process.env.MAP_TILE_URL
    expect(config.tile_url).toBe('https://tiles.example.test/{z}/{x}/{y}.png')
    expect(config.municipality_boundaries).toBe(1)
    expect(config.barangay_boundaries).toBe(0)
    expect(config.center).toEqual([121.97, 13.4])
    expect(config.zoom).toBe(10)
    const viewer = await userWithRole(Role.VIEWER)
    const response = await signedIn(request(app).get('/api/v1/map/config'), viewer)
    expect(contractProblems('/api/v1/map/config', 'get', 200, response.body)).toEqual([])
  })

  it.each(['/api/v1/map/config', '/api/v1/map/boundaries'])('%s needs sign-in', async (url) => {
    expect((await request(app).get(url)).status).toBe(401)
  })
})
