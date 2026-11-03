/**
 * Dashboard figures, computed from approved and locked records on every request and limited to the
 * caller's scope. Nothing is stored (rule 1).
 */
import type { Decimal } from 'decimal.js'
import type { ClientSession, Types } from 'mongoose'

import { dateOnly } from '../lib/dates.js'
import { HalfUp } from '../lib/decimal.js'
import { notFound } from '../lib/errors.js'
import { orderRows } from '../lib/ordering.js'
import { Cap } from '../lib/roles.js'
import { COPIED_SCOPE_PATHS, scopeFilter, within, type Scope } from '../lib/scoping.js'
import {
  Commodity,
  type CommodityDoc,
  GrowthStage,
  type GrowthStageDoc,
  Variety,
  type VarietyDoc,
} from '../models/catalog.models.js'
import {
  CropStand,
  type CropStandDoc,
  Farm,
  type FarmDoc,
  Harvest,
  type HarvestDoc,
  Planting,
  type PlantingDoc,
  PRODUCT_FORMS,
} from '../models/farm.models.js'
import { Barangay, Municipality } from '../models/location.models.js'
import {
  InventoryRecord,
  OFFICIAL_STATUSES,
  SurveyRound,
  type SurveyRoundDoc,
} from '../models/survey.models.js'
import { plantsPerHa } from './catalog.selectors.js'
import { roundForViewer } from './survey.selectors.js'

const FARM_SIZE_BUCKETS: [number, number | null][] = [
  [1, 49],
  [50, 99],
  [100, 249],
  [250, 499],
  [500, 999],
  [1000, null],
]

/** One official record in the caller's scope, with its farmer. */
export interface RecordFact {
  id: string
  barangayId: string
  municipalityId: string
  cropStandId: string
  farmerId: string
  trees: number
  bearingTrees: number
  areaHa: Decimal
  /** Stage code -> count. A stage with an empty count still appears, with 0. */
  stages: Record<string, number>
  hasStageCounts: boolean
}

interface FactFilters {
  municipality?: string | undefined
}

/** The base of every figure here: the round's official records that the caller may see. */
export async function officialFacts(
  round: SurveyRoundDoc,
  scope: Scope,
  { municipality }: FactFilters = {},
  session?: ClientSession,
): Promise<RecordFact[]> {
  const rows = await InventoryRecord.aggregate<{
    _id: string
    barangayId: string
    municipalityId: string
    cropStandId: string
    farmerId: string | null
    stageCounts: {
      growthStageId: string
      count: number | null
      areaHa: Types.Decimal128 | null
    }[]
  }>([
    {
      $match: {
        $and: [
          scopeFilter(scope, Cap.VIEW_AGGREGATES, COPIED_SCOPE_PATHS),
          {
            surveyRoundId: round._id,
            status: { $in: OFFICIAL_STATUSES },
            isDeleted: false,
            ...(municipality ? { municipalityId: municipality } : {}),
          },
        ],
      },
    },
    {
      $lookup: { from: 'crop_stands', localField: 'cropStandId', foreignField: '_id', as: 'stand' },
    },
    { $lookup: { from: 'farms', localField: 'stand.farmId', foreignField: '_id', as: 'farm' } },
    {
      $project: {
        barangayId: 1,
        municipalityId: 1,
        cropStandId: 1,
        stageCounts: 1,
        farmerId: { $first: '$farm.farmerId' },
      },
    },
  ]).session(session ?? null)
  const stages = await GrowthStage.find({
    commodityId: round.commodityId,
    isDeleted: { $in: [true, false] },
  })
    .session(session ?? null)
    .lean<GrowthStageDoc[]>()
  const stageById = new Map(stages.map((stage) => [stage._id, stage]))
  return rows.map((row) => {
    const counts: Record<string, number> = {}
    let trees = 0
    let bearingTrees = 0
    let areaHa = new HalfUp(0)
    for (const { growthStageId, count, areaHa: area } of row.stageCounts) {
      const stage = stageById.get(growthStageId)
      const value = count ?? 0
      trees += value
      if (stage?.isBearing) bearingTrees += value
      if (area) areaHa = areaHa.plus(area.toString())
      const code = stage?.code ?? growthStageId
      counts[code] = (counts[code] ?? 0) + value
    }
    return {
      id: row._id,
      barangayId: row.barangayId,
      municipalityId: row.municipalityId,
      cropStandId: row.cropStandId,
      farmerId: row.farmerId ?? '',
      trees,
      bearingTrees,
      areaHa,
      stages: counts,
      hasStageCounts: row.stageCounts.length > 0,
    }
  })
}

function areaOf(commodity: CommodityDoc, trees: number, stored: Decimal): string | null {
  if (commodity.measureType === 'area') return stored.toFixed(2)
  const density = plantsPerHa(commodity)
  return density ? new HalfUp(trees).dividedBy(density).toFixed(2) : null
}

const rounded = (value: number, places: number) => Number(value.toFixed(places))

interface Totals {
  trees: number
  areaHa: Decimal
  farmers: number
  records: number
  bearingTrees: number
  bearingShare: number | null
  treesPerFarm: number | null
  stages: Record<string, number>
}

function totalsOf(facts: RecordFact[]): Totals {
  const stages: Record<string, number> = {}
  for (const fact of facts) {
    for (const [code, count] of Object.entries(fact.stages)) {
      stages[code] = (stages[code] ?? 0) + count
    }
  }
  const trees = facts.reduce((sum, fact) => sum + fact.trees, 0)
  const bearingTrees = facts.reduce((sum, fact) => sum + fact.bearingTrees, 0)
  return {
    trees,
    areaHa: facts.reduce((sum, fact) => sum.plus(fact.areaHa), new HalfUp(0)),
    farmers: new Set(facts.map((fact) => fact.farmerId)).size,
    records: facts.length,
    bearingTrees,
    bearingShare: trees ? rounded(bearingTrees / trees, 4) : null,
    treesPerFarm: facts.length ? rounded(trees / facts.length, 1) : null,
    stages,
  }
}

async function commodityOf(round: SurveyRoundDoc): Promise<CommodityDoc> {
  const commodity = await Commodity.findOne({ _id: round.commodityId }).lean<CommodityDoc>()
  if (!commodity) throw notFound()
  return commodity
}

/** The latest earlier round of the same crop with official data in scope. */
async function previousRound(
  round: SurveyRoundDoc,
  scope: Scope,
  filters: FactFilters,
): Promise<{ round: SurveyRoundDoc; facts: RecordFact[] } | null> {
  const earlier = await SurveyRound.find({
    commodityId: round.commodityId,
    asOfDate: { $lt: round.asOfDate },
  })
    .sort({ asOfDate: -1 })
    .lean<SurveyRoundDoc[]>()
  for (const candidate of earlier) {
    const facts = await officialFacts(candidate, scope, filters)
    if (facts.length > 0) return { round: candidate, facts }
  }
  return null
}

export async function overview(scope: Scope, roundId: string, filters: FactFilters) {
  const round = await roundForViewer(scope, roundId)
  const commodity = await commodityOf(round)
  const [stages, facts, previous] = await Promise.all([
    GrowthStage.find({ commodityId: round.commodityId })
      .sort({ sortOrder: 1 })
      .lean<GrowthStageDoc[]>(),
    officialFacts(round, scope, filters),
    previousRound(round, scope, filters),
  ])
  const current = totalsOf(facts)
  const before = previous ? totalsOf(previous.facts) : null
  const stageArea = (code: string) => {
    if (commodity.measureType !== 'area') {
      return areaOf(commodity, current.stages[code] ?? 0, new HalfUp(0))
    }
    return null
  }
  return {
    round: { id: round._id, name: round.name },
    previous_round: previous ? { id: previous.round._id, name: previous.round.name } : null,
    trees: current.trees,
    area_ha: areaOf(commodity, current.trees, current.areaHa),
    farmers: current.farmers,
    records: current.records,
    bearing_trees: current.bearingTrees,
    bearing_share: current.bearingShare,
    trees_per_farm: current.treesPerFarm,
    stages: stages.map((stage) => {
      const trees = current.stages[stage.code] ?? 0
      return {
        code: stage.code,
        label: stage.label,
        is_bearing: stage.isBearing,
        trees,
        area_ha: stageArea(stage.code),
        change: before ? trees - (before.stages[stage.code] ?? 0) : null,
      }
    }),
    change: {
      trees: before ? current.trees - before.trees : null,
      farmers: before ? current.farmers - before.farmers : null,
      bearing_share:
        before && current.bearingShare !== null && before.bearingShare !== null
          ? rounded(current.bearingShare - before.bearingShare, 4)
          : null,
    },
  }
}

/** Per municipality, or per barangay, optionally within one municipality. */
export async function breakdown(
  scope: Scope,
  roundId: string,
  level: 'municipality' | 'barangay',
  filters: FactFilters,
) {
  const round = await roundForViewer(scope, roundId)
  const commodity = await commodityOf(round)
  const facts = await officialFacts(round, scope, filters)
  const keyOf = (fact: RecordFact) => (level === 'barangay' ? fact.barangayId : fact.municipalityId)
  const groups = new Map<string, RecordFact[]>()
  for (const fact of facts) groups.set(keyOf(fact), [...(groups.get(keyOf(fact)) ?? []), fact])
  const ids = [...groups.keys()]
  const places =
    level === 'barangay'
      ? await Barangay.find({ _id: { $in: ids } }).lean()
      : await Municipality.find({ _id: { $in: ids } }).lean()
  const nameOf = new Map(places.map((place) => [place._id, place.name]))
  const rows = [...groups]
    // A place whose records have no stage counts at all has nothing to show.
    .filter(([, group]) => group.some((fact) => fact.hasStageCounts))
    .map(([id, group]) => {
      const totals = totalsOf(group)
      return {
        id,
        name: nameOf.get(id) ?? '',
        trees: totals.trees,
        area_ha: areaOf(commodity, totals.trees, totals.areaHa),
        farmers: totals.farmers,
        records: totals.records,
        bearing_share: totals.bearingShare,
        stages: totals.stages,
      }
    })
  return orderRows(rows, undefined, { trees: (row) => row.trees, name: (row) => row.name }, [
    '-trees',
    'name',
  ])
}

/** Totals per round, oldest first, for rounds with official data in scope. */
export async function trends(scope: Scope, commodityId: string, filters: FactFilters) {
  const rounds = await SurveyRound.find({ commodityId })
    .sort({ asOfDate: 1 })
    .lean<SurveyRoundDoc[]>()
  const points = []
  for (const round of rounds) {
    const facts = await officialFacts(round, scope, filters)
    if (facts.length === 0) continue
    const totals = totalsOf(facts)
    points.push({
      round: { id: round._id, name: round.name },
      as_of_date: dateOnly(round.asOfDate),
      trees: totals.trees,
      farmers: totals.farmers,
      bearing_share: totals.bearingShare,
      stages: totals.stages,
    })
  }
  return points
}

/** Farm sizes, planting years and varieties of the official stands in scope. */
export async function distribution(scope: Scope, roundId: string, filters: FactFilters) {
  const round = await roundForViewer(scope, roundId)
  const facts = await officialFacts(round, scope, filters)
  const farmSizes = FARM_SIZE_BUCKETS.map(([low, high]) => ({
    label:
      high === null
        ? `${low.toLocaleString('en-US')}+`
        : `${low.toLocaleString('en-US')}-${high.toLocaleString('en-US')}`,
    farms: facts.filter((fact) => fact.trees >= low && (high === null || fact.trees <= high))
      .length,
  }))
  const zero = facts.filter((fact) => fact.trees === 0).length
  if (zero > 0) farmSizes.unshift({ label: '0', farms: zero })

  const plantings = await Planting.find({
    cropStandId: { $in: facts.map((fact) => fact.cropStandId) },
  }).lean<PlantingDoc[]>()
  const standsByYear = new Map<number, Set<string>>()
  const standsByVariety = new Map<string, Set<string>>()
  for (const planting of plantings) {
    if (planting.yearPlanted !== null) {
      const stands = standsByYear.get(planting.yearPlanted) ?? new Set()
      standsByYear.set(planting.yearPlanted, stands.add(planting.cropStandId))
    }
    for (const id of planting.varietyIds) {
      const stands = standsByVariety.get(id) ?? new Set()
      standsByVariety.set(id, stands.add(planting.cropStandId))
    }
  }
  const varieties = await Variety.find({
    _id: { $in: [...standsByVariety.keys()] },
    isDeleted: { $in: [true, false] },
  }).lean<VarietyDoc[]>()
  const unique = (groups: Iterable<Set<string>>) => new Set([...groups].flatMap((set) => [...set]))
  return {
    farm_sizes: farmSizes,
    planting_years: [...standsByYear]
      .sort((a, b) => a[0] - b[0])
      .map(([year, stands]) => ({ year, stands: stands.size })),
    planting_year_unknown: facts.length - unique(standsByYear.values()).size,
    varieties: orderRows(
      varieties.map((variety) => ({
        code: variety.code,
        name: variety.name,
        stands: standsByVariety.get(variety._id)?.size ?? 0,
      })),
      undefined,
      { stands: (row) => row.stands, code: (row) => row.code },
      ['-stands', 'code'],
    ),
    variety_unknown: facts.length - unique(standsByVariety.values()).size,
    stands: facts.length,
  }
}

/**
 * When official figures last changed. Figures are live, so there is no refresh to report: this is
 * the newest change to a record that is official, or was official and has been reopened.
 */
export async function dataStatus() {
  const latest = await InventoryRecord.findOne({
    $or: [{ status: { $in: OFFICIAL_STATUSES } }, { version: { $gt: 1 } }],
  })
    .sort({ updatedAt: -1 })
    .select('updatedAt')
    .lean()
  return { refreshed_at: latest?.updatedAt.toISOString() ?? null, duration_ms: 0 }
}

// --- Harvests (ADR-0018)

function kgRow(): Record<(typeof PRODUCT_FORMS)[number], Decimal> {
  return {
    wet_beans: new HalfUp(0),
    dried_beans: new HalfUp(0),
    pods: new HalfUp(0),
    unknown: new HalfUp(0),
  }
}

/**
 * Per municipality: harvests, farmers, kg by product form, sacks, and other-unit entries. Kilograms
 * stay per product form, because wet and dried weights are not comparable, and sacks are never
 * converted, because the PAO has not given a sack weight.
 */
export async function harvestSummary(
  scope: Scope,
  { commodity, year }: { commodity?: string | undefined; year?: number | undefined },
) {
  const visible = scopeFilter(scope, Cap.VIEW_AGGREGATES, COPIED_SCOPE_PATHS)
  const conditions: Record<string, unknown>[] = []
  if (commodity) {
    const stands = await CropStand.find({ commodityId: commodity }).select('_id').lean()
    conditions.push({ cropStandId: { $in: stands.map((stand) => stand._id) } })
  }
  const all = await Harvest.find(within(visible, ...conditions)).lean<HarvestDoc[]>()
  const yearOf = (row: HarvestDoc) => row.harvestDate?.getUTCFullYear() ?? null
  const years = [...new Set(all.flatMap((row) => yearOf(row) ?? []))].sort((a, b) => a - b)
  const chosen = year === undefined ? all : all.filter((row) => yearOf(row) === year)
  const undated = year === undefined ? 0 : all.filter((row) => row.harvestDate === null).length

  const stands = await CropStand.find({
    _id: { $in: chosen.map((row) => row.cropStandId) },
    isDeleted: { $in: [true, false] },
  }).lean<CropStandDoc[]>()
  const farms = await Farm.find({
    _id: { $in: stands.map((stand) => stand.farmId) },
    isDeleted: { $in: [true, false] },
  }).lean<FarmDoc[]>()
  const farmerOfFarm = new Map(farms.map((farm) => [farm._id, farm.farmerId]))
  const farmerOfStand = new Map(
    stands.map((stand) => [stand._id, farmerOfFarm.get(stand.farmId) ?? '']),
  )

  const groups = new Map<string, HarvestDoc[]>()
  for (const row of chosen) {
    groups.set(row.municipalityId, [...(groups.get(row.municipalityId) ?? []), row])
  }
  const towns = await Municipality.find({ _id: { $in: [...groups.keys()] } }).lean()
  const townName = new Map(towns.map((town) => [town._id, town.name]))
  const rows = [...groups].map(([municipalityId, group]) => {
    const kg = kgRow()
    let sacks = new HalfUp(0)
    for (const row of group) {
      const quantity = row.quantity.toString()
      if (row.unit === 'kg') kg[row.productForm] = kg[row.productForm].plus(quantity)
      if (row.unit === 'sack') sacks = sacks.plus(quantity)
    }
    return {
      municipality_id: municipalityId,
      municipality: townName.get(municipalityId) ?? '',
      harvests: group.length,
      farmers: new Set(group.map((row) => farmerOfStand.get(row.cropStandId))).size,
      kg: Object.fromEntries(PRODUCT_FORMS.map((form) => [form, kg[form].toFixed(3)])),
      sacks: sacks.toFixed(3),
      other_entries: group.filter((row) => row.unit === 'other').length,
      estimated_dates: group.filter((row) => row.dateEstimated).length,
    }
  })
  return {
    year: year ?? null,
    years,
    undated_excluded: undated,
    rows: orderRows(rows, undefined, { town: (row) => row.municipality }, ['town']),
  }
}
