/** Role by scope matrix for every record-level endpoint (brief §7). New endpoints go in ENDPOINTS. */
import type { Request, Response } from 'express'
import request from 'supertest'
import { beforeAll, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { notFound } from '../src/lib/errors.js'
import { pageOf, pageRequest } from '../src/lib/pagination.js'
import { ALL_ROLES, Cap, Role } from '../src/lib/roles.js'
import { EMPTY_SCOPE, scopeFilter, within, type ScopePaths } from '../src/lib/scoping.js'
import { authOf } from '../src/middleware/auth.js'
import { createThrottles } from '../src/middleware/throttle.js'
import { Barangay, type BarangayDoc, type MunicipalityDoc } from '../src/models/location.models.js'
import type { RouteDefinition } from '../src/routes/registry.js'
import { RECORD_ROUTES } from '../src/routes/records.routes.js'
import { v1Routes, type RouteConfig } from '../src/routes/v1.js'
import {
  actorFor,
  makeAssociation,
  makeBarangay,
  makeFarm,
  makeFarmer,
  makeHarvest,
  makeMunicipality,
  makePlanting,
  makeProgram,
  makeRecord,
  makeStand,
  signedIn,
  userWithRole,
} from './support/factories.js'
import {
  expectedStatus,
  makeActor,
  OTHER,
  OWN,
  type Endpoint,
  type Relation,
} from './support/permissionMatrix.js'

// A scoped route used only here, so the harness and the scoping rules are proved on their own.
const BARANGAY_PATHS: ScopePaths = { barangay: '_id', municipality: 'municipalityId' }

async function listBarangays(req: Request, res: Response): Promise<void> {
  const filter = scopeFilter(authOf(req).scope, Cap.VIEW_RECORDS, BARANGAY_PATHS)
  const page = pageRequest(req)
  const [count, rows] = await Promise.all([
    Barangay.countDocuments(filter),
    Barangay.find(filter).sort({ _id: 1 }).skip(page.skip).limit(page.pageSize).lean(),
  ])
  res.json(
    pageOf(
      req,
      page,
      count,
      rows.map((row) => ({ id: row._id })),
    ),
  )
}

async function getBarangay(req: Request, res: Response): Promise<void> {
  const filter = scopeFilter(authOf(req).scope, Cap.VIEW_RECORDS, BARANGAY_PATHS)
  const row = await Barangay.findOne(within(filter, { _id: req.params.id })).lean()
  if (!row) throw notFound()
  res.json({ id: row._id })
}

const VIEW_RECORDS = { kind: 'capability', capability: Cap.VIEW_RECORDS } as const
const HARNESS_ROUTES: RouteDefinition[] = [
  { method: 'get', path: '/test/barangays', access: VIEW_RECORDS, handlers: [listBarangays] },
  { method: 'get', path: '/test/barangays/:id', access: VIEW_RECORDS, handlers: [getBarangay] },
]

const standIn = async (barangay: BarangayDoc) => makeStand(await makeFarm(barangay))

const ENDPOINTS: Endpoint[] = [
  {
    name: 'scoped barangays (harness self-test)',
    routes: ['GET /test/barangays', 'GET /test/barangays/:id'],
    listUrl: '/api/v1/test/barangays',
    detailUrl: (id) => `/api/v1/test/barangays/${id}`,
    make: (barangay) => Promise.resolve(barangay._id),
  },
  {
    name: 'farmers',
    routes: ['GET /farmers', 'GET /farmers/:id'],
    listUrl: '/api/v1/farmers',
    detailUrl: (id) => `/api/v1/farmers/${id}`,
    make: async (barangay) => (await makeFarmer(barangay))._id,
  },
  {
    name: 'farmer audit trail',
    routes: ['GET /farmers/:id/audit'],
    listUrl: null,
    detailUrl: (id) => `/api/v1/farmers/${id}/audit`,
    make: async (barangay) => (await makeFarmer(barangay))._id,
  },
  {
    name: 'associations',
    routes: ['GET /associations', 'GET /associations/:id'],
    listUrl: '/api/v1/associations',
    detailUrl: (id) => `/api/v1/associations/${id}`,
    make: async (barangay) => (await makeAssociation(barangay.municipalityId))._id,
  },
  {
    name: 'association audit trail',
    routes: ['GET /associations/:id/audit'],
    listUrl: null,
    detailUrl: (id) => `/api/v1/associations/${id}/audit`,
    make: async (barangay) => (await makeAssociation(barangay.municipalityId))._id,
  },
  {
    name: 'association members',
    routes: ['GET /associations/:id/members'],
    listUrl: null,
    detailUrl: (id) => `/api/v1/associations/${id}/members`,
    make: async (barangay) => (await makeAssociation(barangay.municipalityId))._id,
  },
  {
    name: 'farms',
    routes: ['GET /farms', 'GET /farms/:id'],
    listUrl: '/api/v1/farms',
    detailUrl: (id) => `/api/v1/farms/${id}`,
    make: async (barangay) => (await makeFarm(barangay))._id,
  },
  {
    name: 'farm audit trail',
    routes: ['GET /farms/:id/audit'],
    listUrl: null,
    detailUrl: (id) => `/api/v1/farms/${id}/audit`,
    make: async (barangay) => (await makeFarm(barangay))._id,
  },
  {
    name: 'farm crop stands',
    routes: ['GET /farms/:id/crop-stands'],
    listUrl: null,
    detailUrl: (id) => `/api/v1/farms/${id}/crop-stands`,
    make: async (barangay) => (await makeFarm(barangay))._id,
  },
  {
    name: 'farm map points',
    routes: ['GET /farms/points'],
    listUrl: '/api/v1/farms/points',
    detailUrl: null,
    make: async (barangay) =>
      (await makeFarm(barangay, { location: { type: 'Point', coordinates: [121.9, 13.4] } }))._id,
  },
  {
    name: 'crop stands',
    routes: ['GET /crop-stands', 'GET /crop-stands/:id'],
    listUrl: '/api/v1/crop-stands',
    detailUrl: (id) => `/api/v1/crop-stands/${id}`,
    make: async (barangay) => (await standIn(barangay))._id,
  },
  {
    name: 'crop stand audit trail',
    routes: ['GET /crop-stands/:id/audit'],
    listUrl: null,
    detailUrl: (id) => `/api/v1/crop-stands/${id}/audit`,
    make: async (barangay) => (await standIn(barangay))._id,
  },
  {
    name: 'crop stand plantings',
    routes: ['GET /crop-stands/:id/plantings'],
    listUrl: null,
    detailUrl: (id) => `/api/v1/crop-stands/${id}/plantings`,
    make: async (barangay) => (await standIn(barangay))._id,
  },
  {
    name: 'crop stand harvests',
    routes: ['GET /crop-stands/:id/harvests'],
    listUrl: null,
    detailUrl: (id) => `/api/v1/crop-stands/${id}/harvests`,
    make: async (barangay) => (await standIn(barangay))._id,
  },
  {
    name: 'plantings',
    routes: ['GET /plantings/:id'],
    listUrl: null,
    detailUrl: (id) => `/api/v1/plantings/${id}`,
    make: async (barangay) => (await makePlanting(await standIn(barangay)))._id,
  },
  {
    name: 'inventory records',
    routes: ['GET /inventory-records', 'GET /inventory-records/:id'],
    listUrl: '/api/v1/inventory-records',
    detailUrl: (id) => `/api/v1/inventory-records/${id}`,
    make: async (barangay) =>
      (await makeRecord({ stand: await standIn(barangay), counts: { FRUITING: 1 } }))._id,
  },
  {
    name: 'inventory record audit trail',
    routes: ['GET /inventory-records/:id/audit'],
    listUrl: null,
    detailUrl: (id) => `/api/v1/inventory-records/${id}/audit`,
    make: async (barangay) =>
      (await makeRecord({ stand: await standIn(barangay), counts: { FRUITING: 1 } }))._id,
  },
  {
    name: 'inventory record comments',
    routes: ['GET /inventory-records/:id/comments'],
    listUrl: null,
    detailUrl: (id) => `/api/v1/inventory-records/${id}/comments`,
    make: async (barangay) =>
      (await makeRecord({ stand: await standIn(barangay), counts: { FRUITING: 1 } }))._id,
  },
  {
    name: 'harvests',
    routes: ['GET /harvests/:id'],
    listUrl: null,
    detailUrl: (id) => `/api/v1/harvests/${id}`,
    make: async (barangay) => (await makeHarvest(await standIn(barangay)))._id,
  },
]

/** Routes the matrix does not cover, each with the reason. Everything else must have a row. */
const NOT_RECORD_LEVEL: Record<string, string> = {
  'GET /auth/csrf': 'public: sets the CSRF cookie',
  'POST /auth/login': 'public: covered in auth.test.ts',
  'POST /auth/refresh': 'public: covered in auth.test.ts',
  'POST /auth/logout': 'public: covered in auth.test.ts',
  'GET /auth/me': 'the caller only: covered in auth.test.ts',
  ...Object.fromEntries(
    [
      '/municipalities',
      '/municipalities/:id',
      '/barangays',
      '/barangays/:id',
      '/programs',
      '/programs/:id',
      '/commodities',
      '/commodities/:id',
      '/commodities/:id/stages',
      '/varieties',
      '/varieties/:id',
      '/material-sources',
      '/material-sources/:id',
      '/units',
      '/units/:id',
    ].map((path) => [`GET ${path}`, 'reference data, unscoped for all roles: reference.test.ts']),
  ),
  'GET /farmers/duplicates': 'scope covered in registry.test.ts',
  'GET /stats/home': 'aggregates for all roles, scope covered in officialTotals.test.ts',
  'GET /survey-rounds': 'not personal, visible by program: surveys.test.ts',
  'GET /survey-rounds/:id': 'not personal, visible by program: surveys.test.ts',
  'GET /survey-rounds/:id/progress': 'aggregates, scope covered in officialTotals.test.ts',
  'GET /survey-rounds/:id/totals': 'aggregates, scope covered in officialTotals.test.ts',
  'GET /plantings': 'answers 405 and reads nothing: farms.test.ts',
  'GET /harvests': 'answers 405 and reads nothing: farms.test.ts',
  ...Object.fromEntries(
    RECORD_ROUTES.filter((route) => route.method !== 'get').map((route) => [
      `${route.method.toUpperCase()} ${route.path}`,
      'a write: refusals covered below and in the registry, farms and surveys tests',
    ]),
  ),
}

const app = createApp({
  production: false,
  routes: (config: RouteConfig) => [...v1Routes(config), ...HARNESS_ROUTES],
})

let gasan: MunicipalityDoc
let own: BarangayDoc
let other: BarangayDoc

beforeAll(async () => {
  gasan = await makeMunicipality('Gasan')
  const boac = await makeMunicipality('Boac')
  own = await makeBarangay(gasan._id, 'Synthetic Gasan Barangay')
  other = await makeBarangay(boac._id, 'Synthetic Boac Barangay')
})

function objectIn(relation: Relation): BarangayDoc {
  return relation === OWN ? own : other
}

describe.each(ENDPOINTS)('$name', (endpoint) => {
  const { detailUrl, listUrl } = endpoint

  describe.each(ALL_ROLES)('as %s', (role) => {
    it.runIf(detailUrl).each([OWN, OTHER] as const)(
      'reads a detail in %s scope',
      async (relation) => {
        const id = await endpoint.make(objectIn(relation))
        const actor = await makeActor(role, gasan, own)
        const response = await signedIn(request(app).get(detailUrl?.(id) ?? ''), actor)
        expect(response.status).toBe(expectedStatus(endpoint, role, relation))
      },
    )

    it.runIf(listUrl)('lists only rows in scope', async () => {
      const ownId = await endpoint.make(own)
      const otherId = await endpoint.make(other)
      const actor = await makeActor(role, gasan, own)
      const first = await signedIn(request(app).get(listUrl ?? ''), actor)
      if (expectedStatus(endpoint, role, OWN) === 403) {
        expect(first.status).toBe(403)
        return
      }
      expect(first.status).toBe(200)
      // Rows pile up across this file, so every page is read rather than only the first.
      const ids: string[] = []
      let page = first.body as { next?: string | null; results: { id: string }[] }
      for (let number = 2; ; number += 1) {
        ids.push(...page.results.map((row) => row.id))
        if (!page.next) break
        const url = `${listUrl ?? ''}?page=${String(number)}`
        page = (await signedIn(request(app).get(url), actor)).body as typeof page
      }
      expect(ids).toContain(ownId)
      expect(ids.includes(otherId)).toBe(expectedStatus(endpoint, role, OTHER) === 200)
    })
  })
})

describe('scope rules', () => {
  it('gives a Gasan validator a 404, not a 403, on a farmer in Boac (brief §7)', async () => {
    const validator = await userWithRole(Role.MAO_VALIDATOR, { municipalityId: gasan._id })
    const boacFarmer = await makeFarmer(other)
    const url = `/api/v1/farmers/${boacFarmer._id}`
    const response = await signedIn(request(app).get(url), validator)
    expect(response.status).toBe(404)
    expect((response.body as { code: string }).code).toBe('not_found')
  })

  it('keeps the scope when another condition names the same field', () => {
    const none = scopeFilter(EMPTY_SCOPE, Cap.VIEW_RECORDS, BARANGAY_PATHS)
    expect(within(none, { _id: 'x' })).toEqual({ $and: [none, { _id: 'x' }] })
  })

  it('finds nothing for a grant that cannot apply, even when asked by id', async () => {
    const validator = await userWithRole(Role.MAO_VALIDATOR, { municipalityId: gasan._id })
    const { scope } = await actorFor(validator)
    const filter = scopeFilter(scope, Cap.VIEW_RECORDS, {})
    expect(await Barangay.findOne(within(filter, { _id: own._id })).lean()).toBeNull()
  })

  it('hides a crop stand from a coordinator of another program', async () => {
    const stand = await standIn(own)
    const coordinator = await userWithRole(Role.PROGRAM_COORDINATOR, {
      programId: (await makeProgram('RICE'))._id,
    })
    const url = `/api/v1/crop-stands/${stand._id}`
    expect((await signedIn(request(app).get(url), coordinator)).status).toBe(404)
  })

  it('requires sign-in', async () => {
    const response = await request(app).get(`/api/v1/test/barangays/${own._id}`)
    expect(response.status).toBe(401)
  })
})

// Writes: who may create a farmer in their own (Gasan) barangay.
const CREATE_FARMER: Record<Role, number> = {
  system_admin: 201,
  provincial_head: 403,
  program_coordinator: 403,
  provincial_encoder: 201,
  mao_validator: 201,
  field_encoder: 201,
  viewer: 403,
}

describe.each(ALL_ROLES)('writes as %s', (role) => {
  const limited = role === Role.MAO_VALIDATOR || role === Role.FIELD_ENCODER

  it.each([OWN, OTHER] as const)('creates a farmer in %s scope', async (relation) => {
    const actor = await makeActor(role, gasan, own)
    const response = await signedIn(
      request(app)
        .post('/api/v1/farmers')
        .send({
          last_name: 'Sample',
          home_barangay: objectIn(relation)._id,
          consent_given: true,
        }),
      actor,
    )
    const outside = relation === OTHER && limited
    expect(response.status).toBe(outside ? 403 : CREATE_FARMER[role])
  })

  it.each([OWN, OTHER] as const)('edits a farm in %s scope', async (relation) => {
    const farm = await makeFarm(objectIn(relation))
    const actor = await makeActor(role, gasan, own)
    const response = await signedIn(
      request(app).patch(`/api/v1/farms/${farm._id}`).send({ sitio: 'Synthetic' }),
      actor,
    )
    const canEdit = CREATE_FARMER[role] === 201
    const expected = !canEdit ? 403 : relation === OTHER && limited ? 404 : 200
    expect(response.status).toBe(expected)
  })
})

describe('the route table', () => {
  const config = { production: false, csrfTrustedOrigins: [], throttles: createThrottles() }

  it('has a matrix row or a stated exemption for every route', () => {
    const covered = new Set([
      ...ENDPOINTS.flatMap((e) => e.routes),
      ...Object.keys(NOT_RECORD_LEVEL),
    ])
    const missing = v1Routes(config)
      .map((route) => `${route.method.toUpperCase()} ${route.path}`)
      .filter((route) => !covered.has(route))
    expect(missing).toEqual([])
  })

  it('leaves only the stated routes public', () => {
    const open = v1Routes(config)
      .filter((route) => route.access.kind === 'public')
      .map((route) => `${route.method.toUpperCase()} ${route.path}`)
    expect(open.sort()).toEqual([
      'GET /auth/csrf',
      'POST /auth/login',
      'POST /auth/logout',
      'POST /auth/refresh',
    ])
  })
})
