/** The admin API: who may call it, accounts, the catalog and report settings. */
import { deflateSync, crc32 } from 'node:zlib'

import request from 'supertest'
import { beforeAll, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { ALL_ROLES, Role } from '../src/lib/roles.js'
import { User, UserAssignment, type UserDoc } from '../src/models/account.models.js'
import { AuditLog } from '../src/models/auditLog.model.js'
import { Commodity, GrowthStage, MaterialSource, Variety } from '../src/models/catalog.models.js'
import { ReportSettings, Signatory } from '../src/models/report.models.js'
import { ADMIN_ROUTES } from '../src/routes/admin.routes.js'
import { reportLogo, summaryContent, contentHash } from '../src/selectors/report.selectors.js'
import { FULL_SCOPE } from '../src/lib/scoping.js'
import { issueTokens, login } from '../src/services/auth.service.js'
import { contractProblems, contractRoutes } from './support/contract.js'
import {
  makeBarangay,
  makeCommodity,
  makeFarm,
  makeMunicipality,
  makeProgram,
  makeRound,
  makeStand,
  makeUser,
  makeRecord,
  signedIn,
  userWithRole,
} from './support/factories.js'
import { makeActor } from './support/permissionMatrix.js'

const app = createApp({ production: false })
const SYNTHETIC_PASSWORD = 'Correct-Horse-Battery-71'

let admin: UserDoc

beforeAll(async () => {
  admin = await userWithRole(Role.SYSTEM_ADMIN, {}, { isSuperuser: true })
})

function call(method: 'get' | 'post' | 'patch' | 'delete', path: string, user = admin) {
  return signedIn(request(app)[method](`/api/v1/admin${path}`), user)
}

/** The fields these tests read from any response. */
interface Json {
  id: string
  code: string
  fields: Record<string, string[]>
  count: number
  is_active: boolean
  roles: string[]
  assignments: { id: string }[]
  aliases: string[]
  crop_stands: number
  program: { id: string }
  name: string
  letterhead: string
  has_logo: boolean
  order: number
  [index: number]: Json
}

const bodyOf = (response: { body: unknown }): Json => response.body as Json

async function send(method: 'post' | 'patch', path: string, body: object, user: UserDoc = admin) {
  const req = request(app)[method](`/api/v1/admin${path}`).send(body)
  return signedIn(req, user)
}

function onePixelPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 0, 128, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

describe('access', () => {
  const concrete = (path: string) =>
    `/api/v1${path.replaceAll(':id', '00000000-0000-4000-8000-000000000000').replaceAll(':assignment_id', '00000000-0000-4000-8000-000000000001')}`

  it('refuses everyone who is not signed in', async () => {
    for (const route of ADMIN_ROUTES) {
      const response = await request(app)[route.method](concrete(route.path))
      expect(response.status, `${route.method} ${route.path}`).toBe(401)
    }
  })

  it.each(ALL_ROLES.filter((role) => role !== Role.SYSTEM_ADMIN))('refuses a %s', async (role) => {
    const town = await makeMunicipality()
    const home = await makeBarangay(town._id)
    const user = await makeActor(role, town, home)
    for (const route of ADMIN_ROUTES) {
      const response = await signedIn(request(app)[route.method](concrete(route.path)), user)
      expect(response.status, `${route.method} ${route.path}`).toBe(403)
    }
  })

  it('documents every admin route in the contract', () => {
    const documented = contractRoutes()
    const missing = ADMIN_ROUTES.map(
      (route) => `${route.method.toUpperCase()} ${route.path}`,
    ).filter((route) => !documented.has(route))
    expect(missing).toEqual([])
  })
})

describe('staff accounts', () => {
  async function newUser(overrides: object = {}) {
    const email = `sample-${crypto.randomUUID()}@example.test`
    const response = await send('post', '/users', {
      email,
      password: SYNTHETIC_PASSWORD,
      first_name: 'Ana',
      last_name: 'Sample1',
      ...overrides,
    })
    expect(response.status).toBe(201)
    return { id: (response.body as { id: string }).id, email, body: response.body as object }
  }

  it('creates an account that matches the contract and can sign in', async () => {
    const { body, email } = await newUser()
    expect(contractProblems('/api/v1/admin/users', 'post', 201, body)).toEqual([])
    expect(body).not.toHaveProperty('password')
    expect(body).not.toHaveProperty('passwordHash')
    await expect(
      login({ email, password: SYNTHETIC_PASSWORD, ip: '127.0.0.1' }),
    ).resolves.toBeTruthy()
  })

  it('refuses a weak password and a repeated email', async () => {
    const weak = await send('post', '/users', {
      email: 'sample-weak@example.test',
      password: 'short',
    })
    expect(weak.status).toBe(400)
    expect(bodyOf(weak).fields.password).toBeTruthy()
    const { email } = await newUser()
    const repeated = await send('post', '/users', { email, password: SYNTHETIC_PASSWORD })
    expect(repeated.status).toBe(400)
    expect(bodyOf(repeated).fields.email).toBeTruthy()
  })

  it('lists and searches, and the list matches the contract', async () => {
    const lastName = `Searchable${crypto.randomUUID().slice(0, 8)}`
    await newUser({ last_name: lastName })
    const response = await call('get', `/users?q=${lastName}`)
    expect(response.status).toBe(200)
    expect(bodyOf(response).count).toBe(1)
    expect(contractProblems('/api/v1/admin/users', 'get', 200, response.body)).toEqual([])
  })

  it('treats a search as plain text', async () => {
    const response = await call('get', `/users?q=${encodeURIComponent('.*(')}`)
    expect(response.status).toBe(200)
    expect(bodyOf(response).count).toBe(0)
  })

  it('never writes personal values or passwords to the audit log', async () => {
    const { id, email } = await newUser()
    const changed = await send('patch', `/users/${id}`, { last_name: 'Sample2' })
    expect(changed.status).toBe(200)
    await send('post', `/users/${id}/password`, { password: 'Another-Long-Phrase-82' })
    const entries = JSON.stringify(await AuditLog.find({ objectId: id }).lean())
    expect(entries).not.toContain(email)
    expect(entries).not.toContain('Sample2')
    expect(entries).not.toContain('Another-Long-Phrase-82')
    expect(entries).toContain('user.reset_password')
  })

  it('a password reset replaces the password', async () => {
    const { id, email } = await newUser()
    const reset = await send('post', `/users/${id}/password`, {
      password: 'Another-Long-Phrase-82',
    })
    expect(reset.status).toBe(204)
    await expect(
      login({ email, password: SYNTHETIC_PASSWORD, ip: '127.0.0.1' }),
    ).rejects.toBeTruthy()
    await expect(
      login({ email, password: 'Another-Long-Phrase-82', ip: '127.0.0.1' }),
    ).resolves.toBeTruthy()
  })

  it('deactivating stops the account at once', async () => {
    const person = await makeUser()
    expect((await signedIn(request(app).get('/api/v1/auth/me'), person)).status).toBe(200)
    const { access } = await issueTokens(person._id)
    const off = await send('patch', `/users/${person._id}`, { is_active: false })
    expect(off.status).toBe(200)
    expect(bodyOf(off).is_active).toBe(false)
    const after = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${access}`)
    expect(after.status).toBe(401)
  })

  it('refuses deactivating your own account', async () => {
    const response = await send('patch', `/users/${admin._id}`, { is_active: false })
    expect(response.status).toBe(409)
    expect(bodyOf(response).code).toBe('own_account')
  })

  it('answers 404 for an account that does not exist', async () => {
    const id = crypto.randomUUID()
    expect((await call('get', `/users/${id}`)).status).toBe(404)
    expect((await send('patch', `/users/${id}`, { first_name: 'Ana' })).status).toBe(404)
    expect((await send('post', `/users/${id}/password`, { password: 'x' })).status).toBe(404)
    const assign = await send('post', `/users/${id}/assignments`, { role: Role.VIEWER })
    expect(assign.status).toBe(404)
  })

  it('gives and removes assignments, and scope follows at once', async () => {
    const town = await makeMunicipality()
    const person = await makeUser()
    const given = await send('post', `/users/${person._id}/assignments`, {
      role: Role.MAO_VALIDATOR,
      municipality: town._id,
    })
    expect(given.status).toBe(201)
    expect(contractProblems('/api/v1/admin/users/{id}', 'get', 200, given.body)).toEqual([])
    const me = await signedIn(request(app).get('/api/v1/auth/me'), person)
    expect(bodyOf(me).roles).toEqual([Role.MAO_VALIDATOR])

    const assignment = bodyOf(given).assignments[0]?.id ?? ''
    const removed = await call('delete', `/users/${person._id}/assignments/${assignment}`)
    expect(removed.status).toBe(204)
    const after = await signedIn(request(app).get('/api/v1/auth/me'), person)
    expect(bodyOf(after).roles).toEqual([])
  })

  it('checks assignment rules', async () => {
    const person = await makeUser()
    const noTown = await send('post', `/users/${person._id}/assignments`, {
      role: Role.MAO_VALIDATOR,
    })
    expect(noTown.status).toBe(400)
    expect(bodyOf(noTown).fields.municipality).toBeTruthy()
    const town = await makeMunicipality()
    const narrowAdmin = await send('post', `/users/${person._id}/assignments`, {
      role: Role.SYSTEM_ADMIN,
      municipality: town._id,
    })
    expect(narrowAdmin.status).toBe(400)
    expect(bodyOf(narrowAdmin).fields.role).toBeTruthy()
  })

  it("will not remove someone else's assignment through the wrong account", async () => {
    const person = await userWithRole(Role.VIEWER)
    const other = await makeUser()
    const assignment = await UserAssignment.findOne({ userId: person._id }).lean()
    const response = await call('delete', `/users/${other._id}/assignments/${assignment?._id}`)
    expect(response.status).toBe(404)
    expect(await UserAssignment.exists({ _id: assignment?._id })).toBeTruthy()
  })
})

describe('the last administrator', () => {
  /** Leaves exactly one active administrator, and restores everyone afterwards. */
  async function withOnlyAdmin(work: (only: UserDoc, assignmentId: string) => Promise<void>) {
    const superusers = await User.find({ isSuperuser: true, isActive: true }).lean()
    const holders = await UserAssignment.find({ role: Role.SYSTEM_ADMIN }).lean()
    const sidelined = [...superusers.map((u) => u._id), ...holders.map((a) => a.userId)]
    await User.updateMany({ _id: { $in: sidelined } }, { isActive: false })
    const only = await userWithRole(Role.SYSTEM_ADMIN)
    const assignment = await UserAssignment.findOne({ userId: only._id }).lean()
    try {
      await work(only, assignment?._id as string)
    } finally {
      await User.updateMany({ _id: { $in: sidelined } }, { isActive: true })
      await User.updateOne({ _id: only._id }, { isActive: false })
    }
  }

  it('cannot give up their own role', async () => {
    await withOnlyAdmin(async (only, assignmentId) => {
      const path = `/users/${only._id}/assignments/${assignmentId}`
      const response = await call('delete', path, only)
      expect(response.status).toBe(409)
      expect(bodyOf(response).code).toBe('last_admin')
      expect(await UserAssignment.exists({ _id: assignmentId })).toBeTruthy()
    })
  })

  it('can give it up once someone else holds it', async () => {
    await withOnlyAdmin(async (only, assignmentId) => {
      const next = await userWithRole(Role.SYSTEM_ADMIN)
      const path = `/users/${only._id}/assignments/${assignmentId}`
      const response = await call('delete', path, only)
      expect(response.status).toBe(204)
      await User.updateOne({ _id: next._id }, { isActive: false })
    })
  })

  it('does not count an inactive holder as someone else', async () => {
    await withOnlyAdmin(async (only, assignmentId) => {
      const gone = await userWithRole(Role.SYSTEM_ADMIN, {}, { isActive: false })
      const path = `/users/${only._id}/assignments/${assignmentId}`
      const response = await call('delete', path, only)
      expect(response.status).toBe(409)
      expect(gone.isActive).toBe(false)
    })
  })
})

describe('import spellings', () => {
  it('are readable by administrators only, through the admin routes', async () => {
    const program = await makeProgram()
    const crop = await makeCommodity(program._id)
    await send('post', `/commodities/${crop._id}/stages`, {
      code: 'A',
      label: 'Alpha',
      sort_order: 1,
      aliases: ['Young'],
    })
    await send('post', '/varieties', {
      commodity: crop._id,
      code: 'V',
      name: 'Vee',
      aliases: ['Vie'],
    })
    const stages = await call('get', `/commodities/${crop._id}/stages`)
    expect(bodyOf(stages)[0]?.aliases).toEqual(['Young'])
    expect(
      contractProblems('/api/v1/admin/commodities/{id}/stages', 'get', 200, stages.body),
    ).toEqual([])
    const varieties = await call('get', `/varieties?commodity=${crop._id}`)
    expect((varieties.body as { code: string }[]).map((row) => row.code)).toEqual(['V'])
    expect(contractProblems('/api/v1/admin/varieties', 'get', 200, varieties.body)).toEqual([])
    const sources = await call('get', '/material-sources')
    expect(contractProblems('/api/v1/admin/material-sources', 'get', 200, sources.body)).toEqual([])

    const publicView = await signedIn(
      request(app).get(`/api/v1/commodities/${crop._id}/stages`),
      admin,
    )
    expect(bodyOf(publicView)[0]).not.toHaveProperty('aliases')
    const missing = await call('get', `/commodities/${crypto.randomUUID()}/stages`)
    expect(missing.status).toBe(404)
  })
})

describe('setting up a crop', () => {
  async function newCommodity(overrides: object = {}) {
    const program = await makeProgram()
    const code = `CROP${crypto.randomUUID().slice(0, 8)}`
    const response = await send('post', '/commodities', {
      program: program._id,
      code,
      name: `Synthetic crop ${code}`,
      measure_type: 'trees',
      plants_per_ha: 400,
      ...overrides,
    })
    expect(response.status).toBe(201)
    return response.body as { id: string; code: string }
  }

  it('creates a crop and its stages, matching the contract', async () => {
    const crop = await newCommodity()
    expect(contractProblems('/api/v1/admin/commodities', 'post', 201, crop)).toEqual([])
    const stage = await send('post', `/commodities/${crop.id}/stages`, {
      code: 'early',
      label: 'Early',
      sort_order: 1,
      aliases: [' Young ', 'YOUNG', ''],
    })
    expect(stage.status).toBe(201)
    expect(bodyOf(stage).code).toBe('EARLY')
    expect(bodyOf(stage).aliases).toEqual(['Young'])
    expect(
      contractProblems('/api/v1/admin/commodities/{id}/stages', 'post', 201, stage.body),
    ).toEqual([])
    const read = await call('get', `/commodities/${crop.id}/usage`)
    expect(read.body).toEqual({ crop_stands: 0, rounds: 0 })
    expect(
      await AuditLog.exists({ action: 'growth_stage.create', objectId: bodyOf(stage).id }),
    ).toBeTruthy()
  })

  it('refuses a code used twice and an invalid attributes schema', async () => {
    const crop = await newCommodity()
    const program = await makeProgram()
    const repeated = await send('post', '/commodities', {
      program: program._id,
      code: crop.code,
      name: 'Another',
      measure_type: 'trees',
    })
    expect(repeated.status).toBe(400)
    expect(bodyOf(repeated).fields.code).toBeTruthy()
    const schema = await send('patch', `/commodities/${crop.id}`, {
      attributes_schema: { type: 'not-a-type' },
    })
    expect(schema.status).toBe(400)
    expect(bodyOf(schema).fields.attributes_schema).toBeTruthy()
  })

  it('refuses a stage code or position used twice in one crop, but not in another', async () => {
    const crop = await newCommodity()
    const other = await newCommodity()
    const add = (id: string, code: string, sort: number) =>
      send('post', `/commodities/${id}/stages`, { code, label: code, sort_order: sort })
    expect((await add(crop.id, 'A', 1)).status).toBe(201)
    const sameCode = await add(crop.id, 'A', 2)
    expect(sameCode.status).toBe(400)
    expect(bodyOf(sameCode).fields.code).toBeTruthy()
    const samePosition = await add(crop.id, 'B', 1)
    expect(samePosition.status).toBe(400)
    expect(bodyOf(samePosition).fields.sort_order).toBeTruthy()
    expect((await add(other.id, 'A', 1)).status).toBe(201)
  })

  it('refuses a spelling that two stages or varieties would share', async () => {
    const crop = await newCommodity()
    await send('post', `/commodities/${crop.id}/stages`, {
      code: 'A',
      label: 'Alpha',
      sort_order: 1,
      aliases: ['young'],
    })
    const clash = await send('post', `/commodities/${crop.id}/stages`, {
      code: 'B',
      label: 'Beta',
      sort_order: 2,
      aliases: ['Young'],
    })
    expect(clash.status).toBe(400)
    expect(bodyOf(clash).code).toBe('alias_conflict')
    expect(await GrowthStage.exists({ commodityId: crop.id, code: 'B' })).toBeNull()

    await send('post', '/varieties', { commodity: crop.id, code: 'V1', name: 'One' })
    const variety = await send('post', '/varieties', {
      commodity: crop.id,
      code: 'V2',
      name: 'Two',
      aliases: ['one'],
    })
    expect(variety.status).toBe(400)
    expect(await Variety.exists({ commodityId: crop.id, code: 'V2' })).toBeNull()
  })

  it('keeps the program and measure of a crop that has rounds or crop stands', async () => {
    const program = await makeProgram()
    const other = await makeProgram()
    const crop = await makeCommodity(program._id)
    const town = await makeMunicipality()
    const barangay = await makeBarangay(town._id)
    const farm = await makeFarm(barangay)
    await makeStand(farm, crop)

    const move = await send('patch', `/commodities/${crop._id}`, { program: other._id })
    expect(move.status).toBe(409)
    expect(bodyOf(move).fields.program).toBeTruthy()
    const measure = await send('patch', `/commodities/${crop._id}`, { measure_type: 'area' })
    expect(measure.status).toBe(409)
    expect((await Commodity.findById(crop._id).lean())?.programId).toBe(program._id)

    const rename = await send('patch', `/commodities/${crop._id}`, { name: 'Renamed' })
    expect(rename.status).toBe(200)
    const usage = await call('get', `/commodities/${crop._id}/usage`)
    expect(bodyOf(usage).crop_stands).toBe(1)
  })

  it('lets an unused crop change program', async () => {
    const crop = await newCommodity()
    const other = await makeProgram()
    const response = await send('patch', `/commodities/${crop.id}`, { program: other._id })
    expect(response.status).toBe(200)
    expect(bodyOf(response).program.id).toBe(other._id)
  })

  it('keeps stages that records use, and removes those they do not', async () => {
    const program = await makeProgram()
    const crop = await makeCommodity(program._id)
    const free = await send('post', `/commodities/${crop._id}/stages`, {
      code: 'FREE',
      label: 'Free',
      sort_order: 50,
    })
    const used = await send('post', `/commodities/${crop._id}/stages`, {
      code: 'USED',
      label: 'Used',
      sort_order: 51,
    })
    const town = await makeMunicipality()
    const barangay = await makeBarangay(town._id)
    const round = await makeRound(crop)
    const stand = await makeStand(await makeFarm(barangay), crop)
    await makeRecord({ stand, round, counts: { USED: 3 } })

    const refused = await call('delete', `/stages/${bodyOf(used).id}`)
    expect(refused.status).toBe(409)
    expect(bodyOf(refused).code).toBe('in_use')
    expect((await call('delete', `/stages/${bodyOf(free).id}`)).status).toBe(204)
    expect(await GrowthStage.exists({ _id: bodyOf(free).id })).toBeNull()
  })

  it('codes cannot be changed', async () => {
    const crop = await newCommodity()
    const response = await send('patch', `/commodities/${crop.id}`, { code: 'CHANGED' })
    expect(response.status).toBe(200)
    expect(bodyOf(response).code).toBe(crop.code)
  })

  it('edits and removes varieties and sources', async () => {
    const crop = await newCommodity()
    const variety = await send('post', '/varieties', {
      commodity: crop.id,
      code: 'V1',
      name: 'One',
    })
    expect(contractProblems('/api/v1/admin/varieties', 'post', 201, variety.body)).toEqual([])
    const renamed = await send('patch', `/varieties/${bodyOf(variety).id}`, { aliases: ['Uno'] })
    expect(bodyOf(renamed).aliases).toEqual(['Uno'])
    expect((await call('delete', `/varieties/${bodyOf(variety).id}`)).status).toBe(204)
    expect(await Variety.exists({ _id: bodyOf(variety).id })).toBeNull()

    const code = `S${crypto.randomUUID().slice(0, 8)}`
    const source = await send('post', '/material-sources', { code, name: `Source ${code}` })
    expect(source.status).toBe(201)
    expect(contractProblems('/api/v1/admin/material-sources', 'post', 201, source.body)).toEqual([])
    expect((await call('delete', `/material-sources/${bodyOf(source).id}`)).status).toBe(204)
    expect(await MaterialSource.exists({ _id: bodyOf(source).id })).toBeNull()
  })

  it('creates and renames a program', async () => {
    const code = `P${crypto.randomUUID().slice(0, 8)}`
    const created = await send('post', '/programs', { code, name: 'Synthetic program' })
    expect(created.status).toBe(201)
    const renamed = await send('patch', `/programs/${bodyOf(created).id}`, { name: 'Renamed' })
    expect(bodyOf(renamed).name).toBe('Renamed')
    const repeated = await send('post', '/programs', { code, name: 'Again' })
    expect(repeated.status).toBe(400)
  })
})

describe('report settings', () => {
  function uploadLogo(content: Buffer, name: string) {
    return signedIn(
      request(app).post('/api/v1/admin/report-settings/logo').attach('file', content, name),
      admin,
    )
  }

  it('updates the letterhead, and the report uses it', async () => {
    const before = await call('get', '/report-settings')
    expect(contractProblems('/api/v1/admin/report-settings', 'get', 200, before.body)).toEqual([])
    const response = await send('patch', '/report-settings', {
      letterhead: 'Synthetic Office\nSecond line',
      program_line: 'SYNTHETIC PROGRAM',
    })
    expect(response.status).toBe(200)
    expect(bodyOf(response).letterhead).toBe('Synthetic Office\nSecond line')
    const settings = await ReportSettings.findById('current').lean()
    expect(settings?.programLine).toBe('SYNTHETIC PROGRAM')
    expect(await AuditLog.exists({ action: 'report_settings.update' })).toBeTruthy()
  })

  it('stores a valid logo, replaces it and removes it', async () => {
    const png = onePixelPng()
    const uploaded = await uploadLogo(png, 'logo.png')
    expect(uploaded.status).toBe(200)
    expect(bodyOf(uploaded).has_logo).toBe(true)
    expect((await reportLogo())?.equals(png)).toBe(true)
    const removed = await call('delete', '/report-settings/logo')
    expect(bodyOf(removed).has_logo).toBe(false)
    expect(await reportLogo()).toBeNull()
  })

  it('refuses a damaged image, another file type and an oversized file', async () => {
    const png = onePixelPng()
    const broken = Buffer.concat([png.subarray(0, 8), Buffer.from('not really an image')])
    const damaged = await uploadLogo(broken, 'logo.png')
    expect(damaged.status).toBe(400)
    expect(bodyOf(damaged).code).toBe('invalid_logo')
    const other = await uploadLogo(Buffer.from('<svg></svg>'), 'logo.svg')
    expect(other.status).toBe(400)
    const large = await uploadLogo(Buffer.alloc(2 * 1024 * 1024 + 1, 1), 'logo.png')
    expect(large.status).toBe(400)
    expect(bodyOf(large).fields.file?.[0]).toMatch(/2 MB/u)
  })

  it('refuses an upload with no file', async () => {
    const response = await call('post', '/report-settings/logo')
    expect(response.status).toBe(400)
  })

  it('edits signatories, and a change marks the signed report as changed', async () => {
    const program = await makeProgram()
    const crop = await makeCommodity(program._id)
    const round = await makeRound(crop)
    const before = contentHash(await summaryContent(round, FULL_SCOPE))

    const created = await send('post', '/signatories', {
      report_kind: 'summary',
      order: 1,
      caption: 'Prepared by:',
      name: 'Ana Sample1',
      title: 'Synthetic title',
    })
    expect(created.status).toBe(201)
    expect(contractProblems('/api/v1/admin/signatories', 'post', 201, created.body)).toEqual([])
    const content = await summaryContent(round, FULL_SCOPE)
    expect(content.signatories).toContainEqual({
      caption: 'Prepared by:',
      name: 'Ana Sample1',
      title: 'Synthetic title',
    })
    expect(contentHash(content)).not.toBe(before)

    const listed = await call('get', '/signatories')
    expect(contractProblems('/api/v1/admin/signatories', 'get', 200, listed.body)).toEqual([])
    const changed = await send('patch', `/signatories/${bodyOf(created).id}`, { order: 2 })
    expect(bodyOf(changed).order).toBe(2)
    const trail = JSON.stringify(await AuditLog.find({ objectId: bodyOf(created).id }).lean())
    expect(trail).not.toContain('Ana Sample1')
    expect((await call('delete', `/signatories/${bodyOf(created).id}`)).status).toBe(204)
    expect(await Signatory.exists({ _id: bodyOf(created).id })).toBeNull()
    expect((await call('delete', `/signatories/${bodyOf(created).id}`)).status).toBe(404)
  })
})
