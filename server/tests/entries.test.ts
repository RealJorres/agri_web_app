/** One row entered by hand: who may, what it creates or reuses, and that a refusal leaves nothing. */
import request from 'supertest'
import { beforeAll, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { ALL_ROLES, Role } from '../src/lib/roles.js'
import type { UserDoc } from '../src/models/account.models.js'
import { AuditLog } from '../src/models/auditLog.model.js'
import { GrowthStage, type CommodityDoc } from '../src/models/catalog.models.js'
import { CropStand, Farm, Planting } from '../src/models/farm.models.js'
import type { BarangayDoc, MunicipalityDoc } from '../src/models/location.models.js'
import { Farmer } from '../src/models/registry.models.js'
import { InventoryRecord, SurveyRound, type SurveyRoundDoc } from '../src/models/survey.models.js'
import { contractProblems } from './support/contract.js'
import {
  cacao,
  makeBarangay,
  makeFarm,
  makeFarmer,
  makeMunicipality,
  makeRound,
  makeStand,
  signedIn,
  userWithRole,
} from './support/factories.js'

const app = createApp({ production: false })
const API = '/api/v1/inventory-entries'

let gasan: MunicipalityDoc
let boac: MunicipalityDoc
let home: BarangayDoc
let other: BarangayDoc
let boacBrgy: BarangayDoc
let crop: CommodityDoc
let round: SurveyRoundDoc
let encoder: UserDoc
let stageId: string
let sequence = 0

function newFarmer(fields: object = {}) {
  sequence += 1
  return {
    first_name: 'Rosa',
    last_name: `Sampleentry${String(sequence)}`,
    home_barangay: home._id,
    consent_given: true,
    ...fields,
  }
}

function entry(fields: object = {}) {
  return {
    survey_round: round._id,
    new_farmer: newFarmer(),
    counts: [{ growth_stage: stageId, count: 12 }],
    ...fields,
  }
}

beforeAll(async () => {
  await Promise.all([InventoryRecord.init(), SurveyRound.init(), CropStand.init(), Farmer.init()])
  gasan = await makeMunicipality('Gasan Entries')
  boac = await makeMunicipality('Boac Entries')
  home = await makeBarangay(gasan._id, 'Synthetic Entry Home')
  other = await makeBarangay(gasan._id, 'Synthetic Entry Farm')
  boacBrgy = await makeBarangay(boac._id, 'Synthetic Entry Boac')
  crop = await cacao()
  round = await makeRound(crop)
  encoder = await userWithRole(Role.PROVINCIAL_ENCODER)
  const stage = await GrowthStage.findOne({ commodityId: crop._id }).lean()
  stageId = stage?._id as string
})

describe('POST /inventory-entries', () => {
  it('creates the farmer, farm, crop stand, planting and draft from one row', async () => {
    const response = await signedIn(
      request(app)
        .post(API)
        .send(entry({ sitio: 'Sitio Sample', planting: { year_planted: 2019 } })),
      encoder,
    )
    expect(response.status).toBe(201)
    expect(contractProblems(API, 'post', 201, response.body)).toEqual([])
    const body = response.body as {
      id: string
      status: string
      total: number
      farmer: { id: string }
      crop_stand: { id: string }
    }
    expect(body.status).toBe('draft')
    expect(body.total).toBe(12)

    const farmer = await Farmer.findOne({ _id: body.farmer.id }).lean()
    expect(farmer?.consentAt).toBeTruthy()
    const farms = await Farm.find({ farmerId: body.farmer.id }).lean()
    expect(farms.map((farm) => [farm.barangayId, farm.sitio])).toEqual([[home._id, 'Sitio Sample']])
    expect(await Planting.countDocuments({ cropStandId: body.crop_stand.id })).toBe(1)

    const actions = await AuditLog.find({
      actorId: encoder._id,
      objectId: { $in: [body.id, body.farmer.id] },
    })
      .select('action')
      .lean()
    expect(actions.map((log) => log.action).sort()).toEqual(['farmer.create', 'inventory.create'])
  })

  it('keeps the farm in a different barangay when one is given, and adds no empty planting', async () => {
    const response = await signedIn(
      request(app)
        .post(API)
        .send(entry({ barangay: other._id, planting: { year_planted: null, source: null } })),
      encoder,
    )
    expect(response.status).toBe(201)
    const body = response.body as { farmer: { id: string }; crop_stand: { id: string } }
    const farm = await Farm.findOne({ farmerId: body.farmer.id }).lean()
    expect(farm?.barangayId).toBe(other._id)
    expect(await Planting.countDocuments({ cropStandId: body.crop_stand.id })).toBe(0)
  })

  it('reuses the farm and crop stand of a registered farmer', async () => {
    const farmer = await makeFarmer(home)
    const farm = await makeFarm(home, { farmerId: farmer._id })
    const stand = await makeStand(farm, crop)
    const response = await signedIn(
      request(app)
        .post(API)
        .send(entry({ new_farmer: undefined, farmer: farmer._id })),
      encoder,
    )
    expect(response.status).toBe(201)
    expect((response.body as { crop_stand: { id: string } }).crop_stand.id).toBe(stand._id)
    expect(await Farm.countDocuments({ farmerId: farmer._id })).toBe(1)
  })

  it('adds a new farm when a registered farmer farms another sitio', async () => {
    const farmer = await makeFarmer(home)
    await makeFarm(home, { farmerId: farmer._id, sitio: 'Sitio One' })
    const response = await signedIn(
      request(app)
        .post(API)
        .send(entry({ new_farmer: undefined, farmer: farmer._id, sitio: 'Sitio Two' })),
      encoder,
    )
    expect(response.status).toBe(201)
    expect(await Farm.countDocuments({ farmerId: farmer._id })).toBe(2)
  })

  it('refuses a second record in the round, and says so', async () => {
    const farmer = await makeFarmer(home)
    const body = entry({ new_farmer: undefined, farmer: farmer._id })
    const first = await signedIn(request(app).post(API).send(body), encoder)
    expect(first.status).toBe(201)
    const second = await signedIn(request(app).post(API).send(body), encoder)
    expect(second.status).toBe(409)
    expect((second.body as { code: string }).code).toBe('duplicate_record')
  })

  it('leaves nothing behind when the record is refused', async () => {
    const closed = await makeRound(crop, { status: 'closed' })
    const row = newFarmer()
    const response = await signedIn(
      request(app)
        .post(API)
        .send(entry({ survey_round: closed._id, new_farmer: row })),
      encoder,
    )
    expect(response.status).toBe(409)
    expect(await Farmer.countDocuments({ lastName: row.last_name })).toBe(0)
  })

  it('requires consent for a new farmer', async () => {
    const response = await signedIn(
      request(app)
        .post(API)
        .send(entry({ new_farmer: newFarmer({ consent_given: false }) })),
      encoder,
    )
    expect(response.status).toBe(400)
    expect((response.body as { fields: object }).fields).toHaveProperty('consent_given')
  })

  it('wants either a farmer or a new farmer, not both or neither', async () => {
    const farmer = await makeFarmer(home)
    const both = await signedIn(
      request(app)
        .post(API)
        .send(entry({ farmer: farmer._id })),
      encoder,
    )
    expect(both.status).toBe(400)
    const neither = await signedIn(
      request(app)
        .post(API)
        .send(entry({ new_farmer: undefined })),
      encoder,
    )
    expect(neither.status).toBe(400)
  })

  it('hides a farmer outside the assignment', async () => {
    const validator = await userWithRole(Role.MAO_VALIDATOR, { municipalityId: gasan._id })
    const farmer = await makeFarmer(boacBrgy)
    const response = await signedIn(
      request(app)
        .post(API)
        .send(entry({ new_farmer: undefined, farmer: farmer._id })),
      validator,
    )
    expect(response.status).toBe(404)
  })

  it('refuses a new farmer outside the assignment and keeps nothing', async () => {
    const validator = await userWithRole(Role.MAO_VALIDATOR, { municipalityId: gasan._id })
    const row = newFarmer({ home_barangay: boacBrgy._id })
    const response = await signedIn(
      request(app)
        .post(API)
        .send(entry({ new_farmer: row })),
      validator,
    )
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(await Farmer.countDocuments({ lastName: row.last_name })).toBe(0)
  })

  const ALLOWED = new Set<Role>([
    Role.SYSTEM_ADMIN,
    Role.PROVINCIAL_ENCODER,
    Role.MAO_VALIDATOR,
    Role.FIELD_ENCODER,
  ])

  it.each(ALL_ROLES)('as %s', async (role) => {
    const user = await userWithRole(role, { municipalityId: gasan._id })
    const response = await signedIn(request(app).post(API).send(entry()), user)
    expect(response.status).toBe(ALLOWED.has(role) ? 201 : 403)
  })
})
