/** Official numbers: computed from approved or locked records on every request, and never stored. */
import { Decimal } from 'decimal.js'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { Role } from '../src/lib/roles.js'
import type { Scope } from '../src/lib/scoping.js'
import { toDecimal128 } from '../src/lib/decimal.js'
import {
  Commodity,
  GrowthStage,
  Program,
  Variety,
  MaterialSource,
  Unit,
} from '../src/models/catalog.models.js'
import { CropStand, Farm, Harvest, Planting } from '../src/models/farm.models.js'
import { Barangay, Municipality, type BarangayDoc } from '../src/models/location.models.js'
import { Farmer } from '../src/models/registry.models.js'
import { InventoryRecord, SurveyRound, type SurveyRoundDoc } from '../src/models/survey.models.js'
import { getScope } from '../src/selectors/accounts.selectors.js'
import { integrityProblems } from '../src/selectors/integrity.selectors.js'
import {
  homeStats,
  latestOfficialRound,
  roundProgress,
  roundTotals,
  stageTotals,
} from '../src/selectors/survey.selectors.js'
import { contractProblems } from './support/contract.js'
import {
  cacao,
  makeBarangay,
  makeFarm,
  makeMunicipality,
  makeProgram,
  makeRecord,
  makeRound,
  makeStand,
  makeUser,
  signedIn,
  userWithRole,
} from './support/factories.js'

const app = createApp({ production: false })

let gasan: BarangayDoc
let boac: BarangayDoc
let round: SurveyRoundDoc

function standIn(barangay: BarangayDoc) {
  return makeFarm(barangay).then((farm) => makeStand(farm))
}

async function scopeOfRole(role: Role, assignment: object = {}): Promise<Scope> {
  return getScope(await userWithRole(role, assignment))
}

beforeEach(async () => {
  await Promise.all(
    [
      Municipality,
      Barangay,
      Program,
      Commodity,
      GrowthStage,
      Variety,
      MaterialSource,
      Unit,
      Farmer,
      Farm,
      CropStand,
      Planting,
      Harvest,
      SurveyRound,
      InventoryRecord,
    ].map((model) => model.collection.deleteMany({})),
  )
  gasan = await makeBarangay((await makeMunicipality('Gasan'))._id)
  boac = await makeBarangay((await makeMunicipality('Boac'))._id)
  round = await makeRound(await cacao())
  await makeRecord({
    stand: await standIn(gasan),
    round,
    counts: { SEEDLING: 100, FRUITING: 525 },
    status: 'approved',
  })
  await makeRecord({
    stand: await standIn(gasan),
    round,
    counts: { FRUITING: 625 },
    status: 'locked',
  })
  await makeRecord({
    stand: await standIn(boac),
    round,
    counts: { FRUITING: 1250 },
    status: 'approved',
  })
  // Not official yet: must never be counted.
  for (const status of ['draft', 'submitted', 'validated'] as const) {
    await makeRecord({ stand: await standIn(gasan), round, counts: { FRUITING: 9999 }, status })
  }
})

function asTable(rows: Awaited<ReturnType<typeof stageTotals>>) {
  return Object.fromEntries(
    rows.map((row) => [
      `${row.municipality}/${row.stageCode}`,
      [row.count, row.areaHa?.toFixed(2) ?? null],
    ]),
  )
}

describe('stageTotals', () => {
  it('uses only official records and derives the area', async () => {
    const rows = await stageTotals(round, await scopeOfRole(Role.PROVINCIAL_HEAD))
    expect(asTable(rows)).toEqual({
      'Boac/FRUITING': [1250, '2.00'],
      'Gasan/SEEDLING': [100, '0.16'],
      'Gasan/FRUITING': [1150, '1.84'],
    })
    expect(rows.map((row) => `${row.municipality}/${row.stageCode}`)).toEqual([
      'Boac/FRUITING',
      'Gasan/SEEDLING',
      'Gasan/FRUITING',
    ])
  })

  it('is scoped for a validator, while a viewer sees all aggregates', async () => {
    const validator = await scopeOfRole(Role.MAO_VALIDATOR, {
      municipalityId: boac.municipalityId,
    })
    expect(Object.keys(asTable(await stageTotals(round, validator)))).toEqual(['Boac/FRUITING'])
    const viewer = await scopeOfRole(Role.VIEWER)
    expect(await stageTotals(round, viewer)).toHaveLength(3)
  })

  it('leaves out soft-deleted records', async () => {
    await InventoryRecord.updateMany({ status: 'locked' }, { isDeleted: true })
    const rows = await stageTotals(round, await scopeOfRole(Role.VIEWER))
    expect(asTable(rows)['Gasan/FRUITING']?.[0]).toBe(525)
  })

  it('gives nothing to a user with no grants', async () => {
    const scope = await getScope(await makeUser())
    expect(await stageTotals(round, scope)).toEqual([])
  })

  it('follows a farm when it moves', async () => {
    const stand = await standIn(gasan)
    await makeRecord({ stand, round, counts: { FRUITING: 10 }, status: 'approved' })
    const provincial = await userWithRole(Role.PROVINCIAL_ENCODER)
    const { updateFarm } = await import('../src/services/farm.service.js')
    await updateFarm({
      actor: { id: provincial._id, scope: await getScope(provincial) },
      farmId: stand.farmId,
      data: { barangay: boac._id },
    })
    const rows = asTable(await stageTotals(round, await scopeOfRole(Role.VIEWER)))
    expect(rows['Gasan/FRUITING']?.[0]).toBe(1150)
    expect(rows['Boac/FRUITING']?.[0]).toBe(1260)
    expect(await integrityProblems()).toEqual([])
  })

  it('uses stored hectares for an area crop', async () => {
    const rice = await Commodity.create({
      programId: (await makeProgram('RICE'))._id,
      code: 'SAMPLERICE',
      name: 'Sample rice',
      measureType: 'area',
    })
    const planted = await GrowthStage.create({
      commodityId: rice._id,
      code: 'PLANTED',
      label: 'Planted',
      sortOrder: 1,
    })
    const riceRound = await makeRound(rice.toObject())
    const stand = await makeStand(await makeFarm(gasan), rice.toObject())
    await InventoryRecord.create({
      surveyRoundId: riceRound._id,
      cropStandId: stand._id,
      barangayId: stand.barangayId,
      municipalityId: stand.municipalityId,
      programId: stand.programId,
      status: 'approved',
      stageCounts: [{ growthStageId: planted._id, areaHa: toDecimal128('1.5') }],
    })
    const rows = await stageTotals(riceRound, await scopeOfRole(Role.VIEWER))
    expect(asTable(rows)).toEqual({ 'Gasan/PLANTED': [0, '1.50'] })
    expect(rows[0]?.areaHa).toBeInstanceOf(Decimal)
  })

  it('has no area for a tree crop with no density', async () => {
    const crop = await Commodity.create({
      programId: (await makeProgram('NODENSITY'))._id,
      code: 'NODENSITY',
      name: 'Sample crop',
      measureType: 'trees',
    })
    const stage = await GrowthStage.create({
      commodityId: crop._id,
      code: 'ONE',
      label: 'One',
      sortOrder: 1,
    })
    const cropRound = await makeRound(crop.toObject())
    const stand = await makeStand(await makeFarm(gasan), crop.toObject())
    await makeRecord({ stand, round: cropRound, status: 'approved', counts: { [stage.code]: 5 } })
    const rows = await roundTotals(await scopeOfRole(Role.VIEWER), cropRound._id)
    expect(rows[0]).toMatchObject({ count: 5, area_ha: null })
  })

  it('stores no totals anywhere on a record', async () => {
    const record = await InventoryRecord.findOne({
      surveyRoundId: round._id,
      status: 'approved',
    }).lean()
    expect(Object.keys(record ?? {})).not.toContain('total')
    expect(Object.keys(record ?? {}).filter((key) => /total|area/iu.test(key))).toEqual([])
  })
})

describe('roundProgress', () => {
  it('compares expected crop stands with records by status', async () => {
    await standIn(boac) // expected but not yet recorded
    const rows = await roundProgress(await scopeOfRole(Role.VIEWER), round._id)
    const byTown = Object.fromEntries(rows.map((row) => [row.municipality, row]))
    expect(byTown.Gasan).toMatchObject({
      expected: 5,
      draft: 1,
      submitted: 1,
      validated: 1,
      approved: 1,
      locked: 1,
    })
    expect(byTown.Boac).toMatchObject({ expected: 2, approved: 1, draft: 0 })
    expect(rows.map((row) => row.municipality)).toEqual(['Boac', 'Gasan'])
  })

  it('is scoped', async () => {
    const validator = await scopeOfRole(Role.MAO_VALIDATOR, {
      municipalityId: boac.municipalityId,
    })
    const rows = await roundProgress(validator, round._id)
    expect(rows.map((row) => row.municipality)).toEqual(['Boac'])
  })
})

describe('latestOfficialRound', () => {
  it('skips rounds with nothing official', async () => {
    const crop = await cacao()
    await makeRound(crop, { asOfDate: new Date('2030-01-01T00:00:00Z') })
    expect((await latestOfficialRound(crop._id))?._id).toBe(round._id)
  })
})

describe('homeStats', () => {
  it('gives headline numbers, derived from the records', async () => {
    const stats = await homeStats(await scopeOfRole(Role.PROVINCIAL_HEAD))
    expect(stats.farmers).toBe(6)
    expect(stats.farms).toBe(6)
    const [crop] = stats.commodities
    expect(crop?.round.name).toBe(round.name)
    expect(crop?.total).toBe(100 + 525 + 625 + 1250)
    expect(crop?.total_area_ha).toBe('4.00')
    expect(crop?.stages.map((stage) => stage.code)).toEqual([
      'SEEDLING',
      'VEGETATIVE',
      'FLOWERING',
      'FRUITING',
    ])
  })

  it('is limited to the scope', async () => {
    const validator = await scopeOfRole(Role.MAO_VALIDATOR, {
      municipalityId: boac.municipalityId,
    })
    const stats = await homeStats(validator)
    expect(stats.farmers).toBe(1)
    expect(stats.commodities[0]?.total).toBe(1250)
  })

  it('matches the contract, for a viewer too', async () => {
    const viewer = await userWithRole(Role.VIEWER)
    const response = await signedIn(request(app).get('/api/v1/stats/home'), viewer)
    expect(response.status).toBe(200)
    expect(contractProblems('/api/v1/stats/home', 'get', 200, response.body)).toEqual([])
  })
})

describe('integrity', () => {
  it('is clean with records present, and catches a wrong key', async () => {
    expect(await integrityProblems()).toEqual([])
    const record = await InventoryRecord.findOne({ surveyRoundId: round._id }).lean()
    await InventoryRecord.collection.updateOne(
      { _id: record?._id as never },
      { $set: { municipalityId: 'wrong' } },
    )
    const checks = (await integrityProblems()).map((problem) => problem.check)
    expect(checks).toEqual(['inventory_record.scope_keys'])
  })

  it('catches a stage from another crop', async () => {
    const record = await InventoryRecord.findOne({ surveyRoundId: round._id }).lean()
    await InventoryRecord.collection.updateOne(
      { _id: record?._id as never },
      { $set: { stageCounts: [{ growthStageId: 'nowhere', count: 1 }] } },
    )
    const checks = (await integrityProblems()).map((problem) => problem.check)
    expect(checks).toEqual(['inventory_record.stages'])
  })
})
