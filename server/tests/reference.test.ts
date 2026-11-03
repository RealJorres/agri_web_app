/** The read-only reference endpoints: access, filters, ordering and the API contract. */
import request from 'supertest'
import { beforeAll, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { orderRows } from '../src/lib/ordering.js'
import { ALL_ROLES, Role } from '../src/lib/roles.js'
import { Barangay, Municipality } from '../src/models/location.models.js'
import {
  Commodity,
  GrowthStage,
  MaterialSource,
  Program,
  Unit,
  Variety,
} from '../src/models/catalog.models.js'
import { createThrottles } from '../src/middleware/throttle.js'
import { v1Routes } from '../src/routes/v1.js'
import { seedCatalog } from '../src/services/catalog.service.js'
import { seedMunicipalities } from '../src/services/location.service.js'
import { contractProblems, contractRoutes } from './support/contract.js'
import {
  makeBarangay,
  makeCommodity,
  makeProgram,
  makeUser,
  signedIn,
  userWithRole,
} from './support/factories.js'
import { makeActor } from './support/permissionMatrix.js'

const app = createApp({ production: false })

let viewer: Awaited<ReturnType<typeof makeUser>>
let cacaoId: string
let boacId: string
let gasanId: string

beforeAll(async () => {
  await seedMunicipalities()
  await seedCatalog()
  viewer = await userWithRole(Role.VIEWER)
  cacaoId = (await Commodity.findOne({ code: 'CACAO' }).lean())?._id as string
  boacId = (await Municipality.findOne({ name: 'Boac' }).lean())?._id as string
  gasanId = (await Municipality.findOne({ name: 'Gasan' }).lean())?._id as string
  await makeBarangay(boacId, 'Synthetic One')
  await makeBarangay(gasanId, 'Synthetic Two')
  await Barangay.updateOne({ name: 'Synthetic Two' }, { isVerified: true })
})

async function get(url: string) {
  return signedIn(request(app).get(`/api/v1${url}`), viewer)
}

async function namesOf(url: string, key = 'name'): Promise<string[]> {
  const response = await get(url)
  expect(response.status).toBe(200)
  return (response.body as Record<string, string>[]).map((row) => row[key] as string)
}

async function firstId(model: { findOne: () => { lean: () => unknown } }): Promise<string> {
  const row = (await model.findOne().lean()) as { _id: string }
  return row._id
}

describe('the API contract', () => {
  it.each([
    ['/municipalities', '/api/v1/municipalities'],
    ['/barangays', '/api/v1/barangays'],
    ['/programs', '/api/v1/programs'],
    ['/commodities', '/api/v1/commodities'],
    ['/varieties', '/api/v1/varieties'],
    ['/material-sources', '/api/v1/material-sources'],
    ['/units', '/api/v1/units'],
  ])('%s lists match', async (url, path) => {
    const response = await get(url)
    expect(response.status).toBe(200)
    expect((response.body as unknown[]).length).toBeGreaterThan(0)
    expect(contractProblems(path, 'get', 200, response.body)).toEqual([])
  })

  it.each([
    ['/municipalities', '/api/v1/municipalities/{id}', Municipality],
    ['/barangays', '/api/v1/barangays/{id}', Barangay],
    ['/programs', '/api/v1/programs/{id}', Program],
    ['/commodities', '/api/v1/commodities/{id}', Commodity],
    ['/varieties', '/api/v1/varieties/{id}', Variety],
    ['/material-sources', '/api/v1/material-sources/{id}', MaterialSource],
    ['/units', '/api/v1/units/{id}', Unit],
  ])('%s details match', async (url, path, model) => {
    const response = await get(`${url}/${await firstId(model as never)}`)
    expect(response.status).toBe(200)
    expect(contractProblems(path, 'get', 200, response.body)).toEqual([])
  })

  it('commodity stages match', async () => {
    const response = await get(`/commodities/${cacaoId}/stages`)
    const path = '/api/v1/commodities/{id}/stages'
    expect(contractProblems(path, 'get', 200, response.body)).toEqual([])
  })

  it('catches a response that differs, so the checks above mean something', () => {
    const wrong = [{ id: 'not-a-uuid', name: 'Sample', psgc_code: null, extra: 1 }]
    const problems = contractProblems('/api/v1/municipalities', 'get', 200, wrong)
    expect(problems.join(' ')).toMatch(/format "uuid"/)
    expect(problems.join(' ')).toMatch(/additional properties/)
    const missing = contractProblems('/api/v1/municipalities', 'get', 200, [{ name: 'Sample' }])
    expect(missing.join(' ')).toMatch(/required property 'id'/)
  })

  it('every implemented route is in the contract', () => {
    const config = { production: false, csrfTrustedOrigins: [], throttles: createThrottles() }
    const known = contractRoutes()
    const unknown = v1Routes(config)
      .map((route) => `${route.method.toUpperCase()} ${route.path}`)
      .filter((route) => !known.has(route))
    expect(unknown).toEqual([])
  })
})

describe('access', () => {
  it('needs sign-in', async () => {
    expect((await request(app).get('/api/v1/commodities')).status).toBe(401)
  })

  it.each(ALL_ROLES)('is open to %s, with every town visible', async (role) => {
    const municipality = (await Municipality.findById(gasanId).lean()) as never
    const barangay = (await Barangay.findOne({ municipalityId: gasanId }).lean()) as never
    const actor = await makeActor(role, municipality, barangay)
    const response = await signedIn(request(app).get('/api/v1/municipalities'), actor)
    expect(response.status).toBe(200)
    expect(response.body).toHaveLength(6)
  })

  it('is refused to a signed-in user with no role', async () => {
    const response = await signedIn(request(app).get('/api/v1/units'), await makeUser())
    expect(response.status).toBe(403)
  })

  it.each([
    ['post', '/programs'],
    ['patch', `/units/00000000-0000-4000-8000-000000000000`],
    ['delete', `/municipalities/00000000-0000-4000-8000-000000000000`],
  ] as const)('has no %s %s', async (method, url) => {
    const response = await signedIn(request(app)[method](`/api/v1${url}`), viewer)
    expect(response.status).toBe(404)
  })

  it.each(['/programs', '/commodities', '/commodities/x/stages', '/units', '/barangays'])(
    'returns 404 for an unknown id under %s',
    async (url) => {
      const path = url.includes('/x/') ? url : `${url}/not-a-real-id`
      expect((await get(path)).status).toBe(404)
    },
  )

  it('hides a soft-deleted row', async () => {
    const program = await makeProgram()
    await Program.updateOne({ _id: program._id }, { isDeleted: true, deletedAt: new Date() })
    expect((await get(`/programs/${program._id}`)).status).toBe(404)
    expect(await namesOf('/programs', 'id')).not.toContain(program._id)
  })
})

describe('commodities', () => {
  it('embed the program and the stages in order', async () => {
    const body = (await get(`/commodities/${cacaoId}`)).body as unknown
    expect(body).toMatchObject({
      code: 'CACAO',
      measure_type: 'trees',
      spacing_m: '4.00',
      plants_per_ha: 625,
      outlier_multiplier: '5.00',
      program: { code: 'HVCDP' },
    })
    expect((body as { stages: { code: string }[] }).stages.map((stage) => stage.code)).toEqual([
      'SEEDLING',
      'VEGETATIVE',
      'FLOWERING',
      'FRUITING',
    ])
  })

  it('list stages in order', async () => {
    expect(await namesOf(`/commodities/${cacaoId}/stages`, 'code')).toEqual([
      'SEEDLING',
      'VEGETATIVE',
      'FLOWERING',
      'FRUITING',
    ])
  })

  it('filter by program', async () => {
    const other = await makeProgram()
    const crop = await makeCommodity(other._id)
    expect(await namesOf(`/commodities?program=${other._id}`, 'id')).toEqual([crop._id])
    expect((await get(`/commodities/${cacaoId}/stages?program=${other._id}`)).status).toBe(404)
    expect((await get(`/commodities/${crop._id}/stages`)).body).toEqual([])
  })

  it('refuse a filter that is not a UUID', async () => {
    const response = await get('/commodities?program=abc')
    expect(response.status).toBe(400)
    expect((response.body as { fields: object }).fields).toHaveProperty('program')
  })

  it('never treat a query operator as a filter', async () => {
    expect((await get('/commodities?program[$ne]=x')).status).toBe(200)
    expect((await get('/commodities?program=a&program=b')).status).toBe(400)
  })
})

describe('varieties and units', () => {
  it('filter varieties by commodity', async () => {
    const codes = await namesOf(`/varieties?commodity=${cacaoId}`, 'code')
    expect(new Set(codes)).toEqual(new Set(['BR25', 'UF18', 'W10', 'K1', 'CRIOLLO']))
  })

  it('show exact conversions, and none for a sack', async () => {
    const body = (await get('/units')).body as unknown
    const byCode = Object.fromEntries(
      (body as { code: string; to_base: string | null }[]).map((u) => [u.code, u.to_base]),
    )
    expect(byCode).toMatchObject({ KG: '1.000000', SACK: null })
  })

  it('never expose aliases', async () => {
    const body = (await get('/varieties')).body as unknown
    expect((body as object[])[0]).not.toHaveProperty('aliases')
  })

  it('leave stage rows out of other commodities', async () => {
    const crop = await makeCommodity((await makeProgram())._id)
    await GrowthStage.create({ commodityId: crop._id, code: 'S', label: 'Sample', sortOrder: 1 })
    expect(await namesOf(`/commodities/${cacaoId}/stages`, 'code')).not.toContain('S')
  })
})

describe('barangays', () => {
  it('filter by municipality, text and verified state', async () => {
    expect(await namesOf(`/barangays?municipality=${gasanId}`)).toEqual(['Synthetic Two'])
    expect(await namesOf('/barangays?q=one')).toEqual(['Synthetic One'])
    expect(await namesOf('/barangays?is_verified=true')).toEqual(['Synthetic Two'])
    expect(await namesOf('/barangays?is_verified=false')).toEqual(['Synthetic One'])
    expect(await namesOf('/barangays?is_verified=maybe')).toHaveLength(2)
  })

  it('treat search text literally', async () => {
    expect(await namesOf('/barangays?q=.*')).toHaveLength(2)
    expect(await namesOf('/barangays?q=zzz')).toEqual([])
  })

  it('sort by town name, then name, by default', async () => {
    expect(await namesOf('/barangays')).toEqual(['Synthetic One', 'Synthetic Two'])
    expect(await namesOf('/barangays?ordering=-municipality')).toEqual([
      'Synthetic Two',
      'Synthetic One',
    ])
  })
})

describe('ordering', () => {
  it('applies to reference lists', async () => {
    expect((await namesOf('/municipalities?ordering=-name'))[0]).toBe('Torrijos')
    expect((await namesOf('/municipalities'))[0]).toBe('Boac')
    expect(await namesOf('/units', 'code')).toEqual(['HA', 'SACK', 'TREE', 'KG'])
  })

  it('ignores unknown fields', async () => {
    expect((await namesOf('/municipalities?ordering=password,__proto__'))[0]).toBe('Boac')
  })

  it('places empty values last going up and first going down', () => {
    const rows = [{ v: 2 }, { v: null }, { v: 1 }]
    const fields = { v: (row: { v: number | null }) => row.v }
    expect(orderRows(rows, 'v', fields, []).map((r) => r.v)).toEqual([1, 2, null])
    expect(orderRows(rows, '-v', fields, []).map((r) => r.v)).toEqual([null, 2, 1])
  })
})
