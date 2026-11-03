/** Role by scope matrix for every record-level endpoint (brief §7). New endpoints go in ENDPOINTS. */
import type { Request, Response } from 'express'
import request from 'supertest'
import { beforeAll, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { notFound } from '../src/lib/errors.js'
import { pageOf, pageRequest } from '../src/lib/pagination.js'
import { ALL_ROLES, Cap, Role } from '../src/lib/roles.js'
import { scopeFilter, type ScopePaths } from '../src/lib/scoping.js'
import { authOf } from '../src/middleware/auth.js'
import { createThrottles } from '../src/middleware/throttle.js'
import { Barangay, type BarangayDoc, type MunicipalityDoc } from '../src/models/location.models.js'
import type { RouteDefinition } from '../src/routes/registry.js'
import { v1Routes, type RouteConfig } from '../src/routes/v1.js'
import { makeBarangay, makeMunicipality, signedIn, userWithRole } from './support/factories.js'
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
  const row = await Barangay.findOne({ ...filter, _id: req.params.id }).lean()
  if (!row) throw notFound()
  res.json({ id: row._id })
}

const VIEW_RECORDS = { kind: 'capability', capability: Cap.VIEW_RECORDS } as const
const HARNESS_ROUTES: RouteDefinition[] = [
  { method: 'get', path: '/test/barangays', access: VIEW_RECORDS, handlers: [listBarangays] },
  { method: 'get', path: '/test/barangays/:id', access: VIEW_RECORDS, handlers: [getBarangay] },
]

const ENDPOINTS: Endpoint[] = [
  {
    name: 'scoped barangays (harness self-test)',
    routes: ['GET /test/barangays', 'GET /test/barangays/:id'],
    listUrl: '/api/v1/test/barangays',
    detailUrl: (id) => `/api/v1/test/barangays/${id}`,
    make: (barangay) => Promise.resolve(barangay._id),
  },
]

/** Routes the matrix does not cover, each with the reason. Everything else must have a row. */
const NOT_RECORD_LEVEL: Record<string, string> = {
  'GET /auth/csrf': 'public: sets the CSRF cookie',
  'POST /auth/login': 'public: covered in auth.test.ts',
  'POST /auth/refresh': 'public: covered in auth.test.ts',
  'POST /auth/logout': 'public: covered in auth.test.ts',
  'GET /auth/me': 'the caller only: covered in auth.test.ts',
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
      const response = await signedIn(request(app).get(listUrl ?? ''), actor)
      if (expectedStatus(endpoint, role, OWN) === 403) {
        expect(response.status).toBe(403)
        return
      }
      expect(response.status).toBe(200)
      const ids = (response.body as { results: { id: string }[] }).results.map((row) => row.id)
      expect(ids).toContain(ownId)
      expect(ids.includes(otherId)).toBe(expectedStatus(endpoint, role, OTHER) === 200)
    })
  })
})

describe('scope rules', () => {
  it('gives a Gasan validator a 404, not a 403, on an object in Boac', async () => {
    const validator = await userWithRole(Role.MAO_VALIDATOR, { municipalityId: gasan._id })
    const url = `/api/v1/test/barangays/${other._id}`
    const response = await signedIn(request(app).get(url), validator)
    expect(response.status).toBe(404)
    expect((response.body as { code: string }).code).toBe('not_found')
  })

  it('requires sign-in', async () => {
    const response = await request(app).get(`/api/v1/test/barangays/${own._id}`)
    expect(response.status).toBe(401)
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
