import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { toDecimal128 } from '../src/lib/decimal.js'
import { Role } from '../src/lib/roles.js'
import type { Scope } from '../src/lib/scoping.js'
import {
  Commodity,
  type CommodityDoc,
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
import * as analytics from '../src/selectors/analytics.selectors.js'
import { stageTotals } from '../src/selectors/survey.selectors.js'
import { contractProblems } from './support/contract.js'
import {
  actorFor,
  cacao,
  makeBarangay,
  makeFarm,
  makeFarmer,
  makeHarvest,
  makeMunicipality,
  makePlanting,
  makeProgram,
  makeRecord,
  makeRound,
  makeStand,
  makeUser,
  signedIn,
  userWithRole,
} from './support/factories.js'

const app = createApp({ production: false })

let gasanId: string
let boacId: string
let gasanA: BarangayDoc
let gasanB: BarangayDoc
let boac: BarangayDoc
let crop: CommodityDoc
let oldRound: SurveyRoundDoc
let newRound: SurveyRoundDoc

const standIn = async (barangay: BarangayDoc) => makeStand(await makeFarm(barangay))

async function scopeOf(role: Role, assignment: object = {}): Promise<Scope> {
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
  gasanId = (await makeMunicipality('Gasan'))._id
  boacId = (await makeMunicipality('Boac'))._id
  gasanA = await makeBarangay(gasanId, 'Synthetic Gasan A')
  gasanB = await makeBarangay(gasanId, 'Synthetic Gasan B')
  boac = await makeBarangay(boacId, 'Synthetic Boac')
  crop = await cacao()
  oldRound = await makeRound(crop, {
    name: 'Old',
    asOfDate: new Date('2023-07-31T00:00:00Z'),
  })
  newRound = await makeRound(crop, {
    name: 'New',
    asOfDate: new Date('2025-07-31T00:00:00Z'),
  })
  await makeRecord({
    stand: await standIn(gasanA),
    round: oldRound,
    counts: { SEEDLING: 100, FRUITING: 300 },
    status: 'locked',
  })
  await makeRecord({
    stand: await standIn(gasanA),
    round: newRound,
    counts: { FRUITING: 500 },
    status: 'approved',
  })
  await makeRecord({
    stand: await standIn(gasanB),
    round: newRound,
    counts: { VEGETATIVE: 200, FRUITING: 50 },
    status: 'locked',
  })
  await makeRecord({
    stand: await standIn(boac),
    round: newRound,
    counts: { SEEDLING: 1250 },
    status: 'approved',
  })
  for (const status of ['draft', 'submitted', 'validated'] as const) {
    await makeRecord({
      stand: await standIn(boac),
      round: newRound,
      counts: { FRUITING: 9999 },
      status,
    }) // never in analytics
  }
})

describe('figures equal the live official totals, for every scope', () => {
  const cases: [string, () => Promise<Scope>][] = [
    ['provincial head', () => scopeOf(Role.PROVINCIAL_HEAD)],
    ['viewer', () => scopeOf(Role.VIEWER)],
    ['validator', () => scopeOf(Role.MAO_VALIDATOR, { municipalityId: gasanId })],
    ['coordinator', () => scopeOf(Role.PROGRAM_COORDINATOR, { programId: crop.programId })],
    [
      'field encoder',
      () => scopeOf(Role.FIELD_ENCODER, { municipalityId: gasanId, barangayIds: [gasanA._id] }),
    ],
  ]

  it.each(cases)('as %s', async (_name, makeScope) => {
    const scope = await makeScope()
    for (const round of [oldRound, newRound]) {
      const live: Record<string, number> = {}
      for (const row of await stageTotals(round, scope)) {
        live[`${row.municipalityId}/${row.stageCode}`] = row.count
      }
      const towns = await analytics.breakdown(scope, round._id, 'municipality', {})
      const fromBreakdown: Record<string, number> = {}
      for (const town of towns) {
        for (const [code, count] of Object.entries(town.stages)) {
          fromBreakdown[`${town.id}/${code}`] = count
        }
      }
      expect(fromBreakdown).toEqual(live)
      const total = Object.values(live).reduce((sum, count) => sum + count, 0)
      expect((await analytics.overview(scope, round._id, {})).trees).toBe(total)
    }
  })

  it('reflects a change at once, with nothing to refresh', async () => {
    const scope = await scopeOf(Role.VIEWER)
    const before = (await analytics.overview(scope, newRound._id, {})).trees
    await makeRecord({
      stand: await standIn(boac),
      round: newRound,
      counts: { FRUITING: 7 },
      status: 'approved',
    })
    expect((await analytics.overview(scope, newRound._id, {})).trees).toBe(before + 7)
  })
})

describe('overview', () => {
  it('compares with the previous round', async () => {
    const data = await analytics.overview(await scopeOf(Role.VIEWER), newRound._id, {})
    expect(data.trees).toBe(2000)
    expect(data.records).toBe(3)
    expect(data.farmers).toBe(3)
    expect(data.bearing_trees).toBe(550)
    expect(data.bearing_share).toBe(0.275)
    expect(data.area_ha).toBe('3.20') // 2,000 / 625
    expect(data.trees_per_farm).toBe(666.7)
    expect(data.previous_round?.name).toBe('Old')
    expect(data.change.trees).toBe(1600)
    const fruiting = data.stages.find((stage) => stage.code === 'FRUITING')
    expect(fruiting).toMatchObject({ trees: 550, change: 250, is_bearing: true, area_ha: '0.88' })
    expect(data.stages.map((stage) => stage.code)).toEqual([
      'SEEDLING',
      'VEGETATIVE',
      'FLOWERING',
      'FRUITING',
    ])
  })

  it('has no change without a previous round', async () => {
    const data = await analytics.overview(await scopeOf(Role.VIEWER), oldRound._id, {})
    expect(data.previous_round).toBeNull()
    expect(data.change).toEqual({ trees: null, farmers: null, bearing_share: null })
    expect(data.stages.every((stage) => stage.change === null)).toBe(true)
  })

  it('counts one farmer once, across two farms', async () => {
    const farmer = await makeFarmer(gasanA)
    for (const count of [1, 2]) {
      await makeRecord({
        stand: await makeStand(await makeFarm(gasanA, { farmerId: farmer._id })),
        round: oldRound,
        counts: { FRUITING: count },
        status: 'approved',
      })
    }
    const data = await analytics.overview(await scopeOf(Role.VIEWER), oldRound._id, {})
    expect(data.records).toBe(3)
    expect(data.farmers).toBe(2)
  })

  it('compares within the same municipality when filtered', async () => {
    const data = await analytics.overview(await scopeOf(Role.VIEWER), newRound._id, {
      municipality: gasanId,
    })
    expect([data.trees, data.records]).toEqual([750, 2])
    expect(data.change.trees).toBe(350)
  })

  it('uses stored hectares for an area crop', async () => {
    const program = await makeProgram('RICE')
    const rice = await Commodity.create({
      programId: program._id,
      code: 'SAMPLERICE',
      name: 'Sample rice',
      measureType: 'area',
    })
    const stage = await GrowthStage.create({
      commodityId: rice._id,
      code: 'PLANTED',
      label: 'Planted',
      sortOrder: 1,
    })
    const round = await makeRound(rice.toObject())
    const stand = await makeStand(await makeFarm(gasanA), rice.toObject())
    await InventoryRecord.create({
      surveyRoundId: round._id,
      cropStandId: stand._id,
      barangayId: stand.barangayId,
      municipalityId: stand.municipalityId,
      programId: stand.programId,
      status: 'approved',
      stageCounts: [{ growthStageId: stage._id, areaHa: toDecimal128('1.5') }],
    })
    const data = await analytics.overview(await scopeOf(Role.VIEWER), round._id, {})
    expect(data.area_ha).toBe('1.50')
    expect(data.trees).toBe(0)
  })
})

describe('breakdown', () => {
  it('groups by municipality and by barangay, largest first', async () => {
    const scope = await scopeOf(Role.PROVINCIAL_HEAD)
    const towns = await analytics.breakdown(scope, newRound._id, 'municipality', {})
    expect(towns.map((row) => [row.name, row.trees, row.records])).toEqual([
      ['Boac', 1250, 1],
      ['Gasan', 750, 2],
    ])
    expect(towns[1]?.stages).toEqual({ FRUITING: 550, VEGETATIVE: 200 })
    expect(towns[0]?.bearing_share).toBe(0)
    const barangays = await analytics.breakdown(scope, newRound._id, 'barangay', {
      municipality: gasanId,
    })
    expect(barangays.map((row) => [row.name, row.trees])).toEqual([
      ['Synthetic Gasan A', 500],
      ['Synthetic Gasan B', 250],
    ])
  })

  it('leaves out a place whose records have no stage counts', async () => {
    const empty = await makeBarangay(gasanId, 'Synthetic Empty')
    await makeRecord({ stand: await standIn(empty), round: newRound, status: 'approved' })
    const scope = await scopeOf(Role.VIEWER)
    const rows = await analytics.breakdown(scope, newRound._id, 'barangay', {})
    expect(rows.map((row) => row.name)).not.toContain('Synthetic Empty')
  })

  it('shows a validator only their own municipality', async () => {
    const scope = await scopeOf(Role.MAO_VALIDATOR, { municipalityId: gasanId })
    expect((await analytics.overview(scope, newRound._id, {})).trees).toBe(750)
    const rows = await analytics.breakdown(scope, newRound._id, 'municipality', {})
    expect(rows.map((row) => row.name)).toEqual(['Gasan'])
    const elsewhere = await analytics.overview(scope, newRound._id, { municipality: boacId })
    expect(elsewhere.trees).toBe(0)
  })
})

describe('trends', () => {
  it('runs oldest first, leaving out rounds with nothing official', async () => {
    await makeRound(crop, { name: 'Empty', asOfDate: new Date('2024-01-01T00:00:00Z') })
    const points = await analytics.trends(await scopeOf(Role.VIEWER), crop._id, {})
    expect(points.map((point) => [point.round.name, point.trees, point.as_of_date])).toEqual([
      ['Old', 400, '2023-07-31'],
      ['New', 2000, '2025-07-31'],
    ])
  })
})

describe('distribution', () => {
  it('reports sizes, years and varieties', async () => {
    const records = await InventoryRecord.find({
      surveyRoundId: newRound._id,
      status: 'approved',
    }).lean()
    const big = records.find((row) => row.stageCounts[0]?.count === 500)
    const stand = await CropStand.findOne({ _id: big?.cropStandId }).lean()
    const variety = await Variety.findOne({ commodityId: crop._id, code: 'BR25' }).lean()
    await makePlanting(stand as never, {
      yearPlanted: 2019,
      varietyIds: [variety?._id as string],
    })
    const data = await analytics.distribution(await scopeOf(Role.VIEWER), newRound._id, {})
    const sizes = Object.fromEntries(data.farm_sizes.map((row) => [row.label, row.farms]))
    expect(sizes['250-499']).toBe(1)
    expect(sizes['500-999']).toBe(1)
    expect(sizes['1,000+']).toBe(1)
    expect(sizes['0']).toBeUndefined()
    expect(data.planting_years).toEqual([{ year: 2019, stands: 1 }])
    expect(data.planting_year_unknown).toBe(2)
    expect(data.varieties).toEqual([{ code: 'BR25', name: 'BR 25', stands: 1 }])
    expect(data.variety_unknown).toBe(2)
    expect(data.stands).toBe(3)
  })

  it('adds a zero bucket when a stand counted no trees', async () => {
    await makeRecord({ stand: await standIn(gasanA), round: newRound, status: 'approved' })
    const data = await analytics.distribution(await scopeOf(Role.VIEWER), newRound._id, {})
    expect(data.farm_sizes[0]).toEqual({ label: '0', farms: 1 })
  })
})

describe('dataStatus', () => {
  it('reports the newest change to official figures', async () => {
    const { refreshed_at: first, duration_ms: duration } = await analytics.dataStatus()
    expect(first).not.toBeNull()
    expect(duration).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const record = await InventoryRecord.findOne({ status: 'approved' })
    if (!record) throw new Error('no record')
    const { reopen } = await import('../src/services/survey.service.js')
    const actor = await actorFor(await userWithRole(Role.PROGRAM_COORDINATOR))
    await reopen({ actor, recordId: record._id, comment: 'Synthetic correction' })
    const { refreshed_at: after } = await analytics.dataStatus()
    expect(new Date(after ?? 0).getTime()).toBeGreaterThan(new Date(first ?? 0).getTime())
  })

  it('ignores a draft that was never official', async () => {
    const { refreshed_at: before } = await analytics.dataStatus()
    await new Promise((resolve) => setTimeout(resolve, 5))
    await makeRecord({ stand: await standIn(boac), round: newRound, status: 'draft' })
    expect((await analytics.dataStatus()).refreshed_at).toBe(before)
  })

  it('is empty before any official record exists', async () => {
    await InventoryRecord.collection.deleteMany({})
    expect(await analytics.dataStatus()).toEqual({ refreshed_at: null, duration_ms: 0 })
  })
})

describe('harvest summary (ADR-0018)', () => {
  const dated = (text: string) => new Date(`${text}T00:00:00Z`)

  async function world() {
    const farmer = await makeFarmer(gasanA)
    const g1 = await makeStand(await makeFarm(gasanA, { farmerId: farmer._id }))
    const g2 = await makeStand(await makeFarm(gasanA, { farmerId: farmer._id })) // same farmer
    const g3 = await standIn(gasanA)
    const b1 = await standIn(boac)
    await makeHarvest(g1, { quantity: '8', productForm: 'unknown', dateEstimated: true })
    await makeHarvest(g1, {
      quantity: '6',
      productForm: 'dried_beans',
      harvestDate: dated('2025-03-01'),
    })
    await makeHarvest(g2, {
      quantity: '20',
      productForm: 'wet_beans',
      harvestDate: dated('2025-04-01'),
    })
    await makeHarvest(g3, {
      quantity: '1',
      unit: 'sack',
      productForm: 'dried_beans',
      harvestDate: dated('2025-05-01'),
    })
    await makeHarvest(g3, {
      quantity: '3',
      unit: 'other',
      productForm: 'pods',
      harvestDate: dated('2024-05-01'),
    })
    await makeHarvest(b1, {
      quantity: '2.5',
      productForm: 'dried_beans',
      harvestDate: dated('2025-06-01'),
    })
    const gone = await makeHarvest(b1, {
      quantity: '999',
      productForm: 'dried_beans',
      harvestDate: dated('2025-06-02'),
    })
    await Harvest.updateOne({ _id: gone._id }, { isDeleted: true })
  }

  const byTown = (rows: { municipality: string }[]) =>
    Object.fromEntries(rows.map((row) => [row.municipality, row])) as Record<string, never>

  it('keeps kilograms per form, and never converts sacks', async () => {
    await world()
    const data = await analytics.harvestSummary(await scopeOf(Role.PROVINCIAL_HEAD), {})
    const gasan = (data.rows as unknown as Record<string, unknown>[]).find(
      (row) => row.municipality === 'Gasan',
    )
    expect(gasan).toMatchObject({
      harvests: 5,
      farmers: 2,
      kg: { wet_beans: '20.000', dried_beans: '6.000', pods: '0.000', unknown: '8.000' },
      sacks: '1.000',
      other_entries: 1,
      estimated_dates: 1,
    })
    expect(byTown(data.rows).Boac).toMatchObject({ kg: { dried_beans: '2.500' } })
    expect(data.years).toEqual([2024, 2025])
    expect(data.undated_excluded).toBe(0)
  })

  it('reports undated harvests separately when filtering by year', async () => {
    await world()
    const data = await analytics.harvestSummary(await scopeOf(Role.PROVINCIAL_HEAD), { year: 2025 })
    expect(byTown(data.rows).Gasan).toMatchObject({
      harvests: 3,
      kg: { unknown: '0.000' },
      other_entries: 0,
    })
    expect(data.undated_excluded).toBe(1)
    expect(data.year).toBe(2025)
  })

  it('is scoped', async () => {
    await world()
    const scope = await scopeOf(Role.MAO_VALIDATOR, { municipalityId: boacId })
    const data = await analytics.harvestSummary(scope, {})
    expect(data.rows.map((row) => row.municipality)).toEqual(['Boac'])
  })

  it('filters by crop', async () => {
    await world()
    const other = await Commodity.create({
      programId: crop.programId,
      code: 'OTHER',
      name: 'Other',
      measureType: 'trees',
    })
    const data = await analytics.harvestSummary(await scopeOf(Role.VIEWER), {
      commodity: other._id,
    })
    expect(data.rows).toEqual([])
  })
})

describe('the API', () => {
  it('matches the contract, for a viewer', async () => {
    const viewer = await userWithRole(Role.VIEWER)
    await makeHarvest(await standIn(gasanA), { productForm: 'unknown' })
    const id = newRound._id
    const checks: [string, string][] = [
      [`/api/v1/analytics/rounds/${id}/overview`, '/api/v1/analytics/rounds/{id}/overview'],
      [
        `/api/v1/analytics/rounds/${oldRound._id}/overview`,
        '/api/v1/analytics/rounds/{id}/overview',
      ],
      [`/api/v1/analytics/rounds/${id}/breakdown`, '/api/v1/analytics/rounds/{id}/breakdown'],
      [
        `/api/v1/analytics/rounds/${id}/breakdown?level=barangay&municipality=${gasanId}`,
        '/api/v1/analytics/rounds/{id}/breakdown',
      ],
      [`/api/v1/analytics/rounds/${id}/distribution`, '/api/v1/analytics/rounds/{id}/distribution'],
      [`/api/v1/analytics/trends?commodity=${crop._id}`, '/api/v1/analytics/trends'],
      ['/api/v1/analytics/status', '/api/v1/analytics/status'],
      ['/api/v1/analytics/harvests', '/api/v1/analytics/harvests'],
      ['/api/v1/analytics/harvests?year=2025', '/api/v1/analytics/harvests'],
    ]
    for (const [url, path] of checks) {
      const response = await signedIn(request(app).get(url), viewer)
      expect(response.status).toBe(200)
      expect(contractProblems(path, 'get', 200, response.body)).toEqual([])
    }
  })

  it('refuses what it should', async () => {
    const url = `/api/v1/analytics/rounds/${newRound._id}/overview`
    expect((await request(app).get(url)).status).toBe(401)
    expect((await signedIn(request(app).get(url), await makeUser())).status).toBe(403)
    const viewer = await userWithRole(Role.VIEWER)
    const get = async (path: string) => (await signedIn(request(app).get(path), viewer)).status
    expect(await get(`/api/v1/analytics/rounds/${newRound._id}/breakdown?level=sitio`)).toBe(400)
    expect(await get('/api/v1/analytics/trends')).toBe(400)
    expect(
      await get('/api/v1/analytics/trends?commodity=00000000-0000-4000-8000-000000000000'),
    ).toBe(400)
    expect(await get('/api/v1/analytics/harvests?year=x')).toBe(400)
    expect(
      await get('/api/v1/analytics/rounds/00000000-0000-4000-8000-000000000000/overview'),
    ).toBe(404)
  })

  it('hides a round from another program', async () => {
    const other = await userWithRole(Role.PROGRAM_COORDINATOR, {
      programId: (await makeProgram('OTHER'))._id,
    })
    const url = `/api/v1/analytics/rounds/${newRound._id}/overview`
    expect((await signedIn(request(app).get(url), other)).status).toBe(404)
  })

  it('never shows names or buyers', async () => {
    await makeHarvest(await standIn(gasanA), { buyer: 'Synthetic Buyer' })
    const viewer = await userWithRole(Role.VIEWER)
    const response = await signedIn(request(app).get('/api/v1/analytics/harvests'), viewer)
    expect(JSON.stringify(response.body)).not.toContain('Synthetic Buyer')
  })
})
