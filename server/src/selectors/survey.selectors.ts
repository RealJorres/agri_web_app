/**
 * Reads for rounds, records and the official numbers. Totals are always computed from approved or
 * locked records when asked for; nothing is stored (rule 1).
 */
import type { Decimal } from 'decimal.js'
import type { Types } from 'mongoose'

import { dateOnly } from '../lib/dates.js'
import { decimalString, HalfUp } from '../lib/decimal.js'
import { notFound } from '../lib/errors.js'
import { orderRows, type SortFields } from '../lib/ordering.js'
import type { PageRequest } from '../lib/pagination.js'
import { Cap } from '../lib/roles.js'
import { COPIED_SCOPE_PATHS, scopeFilter, within, type Scope } from '../lib/scoping.js'
import { User } from '../models/account.models.js'
import {
  Commodity,
  type CommodityDoc,
  GrowthStage,
  type GrowthStageDoc,
} from '../models/catalog.models.js'
import {
  CropStand,
  type CropStandDoc,
  Farm,
  FARM_SCOPE,
  type FarmDoc,
} from '../models/farm.models.js'
import { Municipality } from '../models/location.models.js'
import {
  Farmer,
  farmerDisplayName,
  FARMER_SCOPE,
  type FarmerDoc,
} from '../models/registry.models.js'
import {
  InventoryRecord,
  type InventoryRecordDoc,
  OFFICIAL_STATUSES,
  RECORD_STATUSES,
  SurveyRound,
  type SurveyRoundDoc,
  WorkflowComment,
  type WorkflowCommentDoc,
} from '../models/survey.models.js'
import { allowedActions } from '../services/surveyWorkflow.js'
import { plantsPerHa } from './catalog.selectors.js'
import { hidePersonal, locationRefs } from './registry.selectors.js'

type Filter = Record<string, unknown>

function byOwnId<Row extends { _id: string }>(rows: Row[]): Map<string, Row> {
  return new Map(rows.map((row) => [row._id, row]))
}

/** Rounds are not personal: visible to everyone whose grants cover the program. */
function roundFilter(scope: Scope): Filter {
  const programIds = scope.grantsWith(Cap.VIEW_AGGREGATES).map((grant) => grant.programId)
  if (programIds.length === 0) return { _id: { $in: [] } }
  if (programIds.includes(null)) return {}
  return { programId: { $in: programIds } }
}

async function roundViews(rows: SurveyRoundDoc[]) {
  const commodities = await Commodity.find({ _id: { $in: rows.map((row) => row.commodityId) } })
    .select('name')
    .lean<CommodityDoc[]>()
  const commodityName = new Map(commodities.map((row) => [row._id, row.name]))
  return rows.map((row) => ({
    id: row._id,
    commodity: row.commodityId,
    commodity_name: commodityName.get(row.commodityId) ?? '',
    name: row.name,
    as_of_date: dateOnly(row.asOfDate),
    deadline: dateOnly(row.deadline),
    status: row.status,
    is_historical: row.isHistorical,
    closed_at: row.closedAt?.toISOString() ?? null,
  }))
}

const ROUND_ORDER: SortFields<SurveyRoundDoc> = {
  id: (row) => row._id,
  name: (row) => row.name,
  as_of_date: (row) => row.asOfDate.getTime(),
  deadline: (row) => row.deadline?.getTime() ?? null,
  status: (row) => row.status,
  is_historical: (row) => row.isHistorical,
  closed_at: (row) => row.closedAt?.getTime() ?? null,
}

export async function listRounds(
  scope: Scope,
  filters: { commodity?: string | undefined; status?: string | undefined },
  page: PageRequest,
  ordering: unknown,
) {
  const conditions: Filter[] = []
  if (filters.commodity) conditions.push({ commodityId: filters.commodity })
  if (filters.status) conditions.push({ status: filters.status })
  const rows = await SurveyRound.find(within(roundFilter(scope), ...conditions)).lean<
    SurveyRoundDoc[]
  >()
  const ordered = orderRows(rows, ordering, ROUND_ORDER, ['-as_of_date'])
  return {
    count: ordered.length,
    results: await roundViews(ordered.slice(page.skip, page.skip + page.pageSize)),
  }
}

async function roundById(scope: Scope, id: string): Promise<SurveyRoundDoc> {
  const row = await SurveyRound.findOne(
    within(roundFilter(scope), { _id: id }),
  ).lean<SurveyRoundDoc>()
  if (!row) throw notFound()
  return row
}

export async function requireRound(scope: Scope, id: string): Promise<void> {
  await roundById(scope, id)
}

export async function getRound(scope: Scope, id: string) {
  const [view] = await roundViews([await roundById(scope, id)])
  if (!view) throw notFound()
  return view
}

// --- Records

async function recordViews(scope: Scope, rows: InventoryRecordDoc[]) {
  const [rounds, stands] = await Promise.all([
    SurveyRound.find({ _id: { $in: rows.map((row) => row.surveyRoundId) } }).lean<
      SurveyRoundDoc[]
    >(),
    CropStand.find({
      _id: { $in: rows.map((row) => row.cropStandId) },
      isDeleted: { $in: [true, false] },
    }).lean<CropStandDoc[]>(),
  ])
  const standById = byOwnId(stands)
  const [commodities, farms, stages] = await Promise.all([
    Commodity.find({ _id: { $in: stands.map((row) => row.commodityId) } }).lean<CommodityDoc[]>(),
    Farm.find({
      _id: { $in: stands.map((row) => row.farmId) },
      isDeleted: { $in: [true, false] },
    }).lean<FarmDoc[]>(),
    GrowthStage.find({
      _id: { $in: rows.flatMap((row) => row.stageCounts.map((count) => count.growthStageId)) },
      isDeleted: { $in: [true, false] },
    }).lean<GrowthStageDoc[]>(),
  ])
  const farmers = await Farmer.find({
    _id: { $in: farms.map((row) => row.farmerId) },
    isDeleted: { $in: [true, false] },
  }).lean<FarmerDoc[]>()
  const refs = await locationRefs(farms.map((row) => row.barangayId))
  const roundById_ = byOwnId(rounds)
  const commodityById = byOwnId(commodities)
  const farmById = byOwnId(farms)
  const farmerById = byOwnId(farmers)
  const stageById = byOwnId(stages)

  return rows.map((row) => {
    const round = roundById_.get(row.surveyRoundId)
    const stand = standById.get(row.cropStandId)
    const commodity = stand ? commodityById.get(stand.commodityId) : undefined
    const farm = stand ? farmById.get(stand.farmId) : undefined
    const farmer = farm ? farmerById.get(farm.farmerId) : undefined
    const location = farm ? refs.get(farm.barangayId) : undefined
    const counts = orderRows(
      row.stageCounts.map((count) => {
        const stage = stageById.get(count.growthStageId)
        return {
          growth_stage: {
            id: count.growthStageId,
            code: stage?.code ?? '',
            label: stage?.label ?? '',
            sort_order: stage?.sortOrder ?? 0,
          },
          count: count.count,
          area_ha: decimalString(count.areaHa, 4),
        }
      }),
      undefined,
      { order: (count) => count.growth_stage.sort_order },
      ['order'],
    )
    const view = {
      id: row._id,
      survey_round: { id: row.surveyRoundId, name: round?.name ?? '' },
      crop_stand: {
        id: row.cropStandId,
        commodity: commodity?.code ?? '',
        commodity_name: commodity?.name ?? '',
      },
      farm: {
        id: farm?._id ?? '',
        barangay: location?.barangay.name ?? '',
        municipality: location?.municipality.name ?? '',
      },
      farmer: { id: farmer?._id ?? '', display_name: farmer ? farmerDisplayName(farmer) : '' },
      status: row.status,
      version: row.version,
      counts,
      total: row.stageCounts.reduce((sum, count) => sum + (count.count ?? 0), 0),
      remarks: row.remarks,
      flags: row.flags,
      submitted_at: row.submittedAt?.toISOString() ?? null,
      validated_at: row.validatedAt?.toISOString() ?? null,
      approved_at: row.approvedAt?.toISOString() ?? null,
      updated_at: row.updatedAt.toISOString(),
      allowed_actions: allowedActions(scope, row, round?.status ?? 'closed'),
    }
    return hidePersonal(scope, view, ['farmer'])
  })
}

export interface RecordFilters {
  survey_round?: string | undefined
  crop_stand?: string | undefined
  farmer?: string | undefined
  municipality?: string | undefined
  barangay?: string | undefined
  status?: string[] | undefined
}

const RECORD_ORDER: SortFields<InventoryRecordDoc> = {
  updated_at: (row) => row.updatedAt.getTime(),
  submitted_at: (row) => row.submittedAt?.getTime() ?? null,
  status: (row) => row.status,
}

export async function listRecords(
  scope: Scope,
  filters: RecordFilters,
  page: PageRequest,
  ordering: unknown,
) {
  const conditions: Filter[] = []
  if (filters.survey_round) conditions.push({ surveyRoundId: filters.survey_round })
  if (filters.crop_stand) conditions.push({ cropStandId: filters.crop_stand })
  if (filters.municipality) conditions.push({ municipalityId: filters.municipality })
  if (filters.barangay) conditions.push({ barangayId: filters.barangay })
  if (filters.status?.length) conditions.push({ status: { $in: filters.status } })
  if (filters.farmer) {
    const farms = await Farm.find({ farmerId: filters.farmer }).select('_id').lean()
    const stands = await CropStand.find({ farmId: { $in: farms.map((row) => row._id) } })
      .select('_id')
      .lean()
    conditions.push({ cropStandId: { $in: stands.map((row) => row._id) } })
  }
  const visible = scopeFilter(scope, Cap.VIEW_RECORDS, COPIED_SCOPE_PATHS)
  const rows = await InventoryRecord.find(within(visible, ...conditions))
    .select('updatedAt submittedAt status')
    .lean<InventoryRecordDoc[]>()
  const ordered = orderRows(rows, ordering, RECORD_ORDER, ['-updated_at'])
  const pageIds = ordered.slice(page.skip, page.skip + page.pageSize).map((row) => row._id)
  const full = byOwnId(
    await InventoryRecord.find({ _id: { $in: pageIds } }).lean<InventoryRecordDoc[]>(),
  )
  return {
    count: ordered.length,
    results: await recordViews(
      scope,
      pageIds.flatMap((id) => full.get(id) ?? []),
    ),
  }
}

async function recordById(scope: Scope, id: string): Promise<InventoryRecordDoc> {
  const visible = scopeFilter(scope, Cap.VIEW_RECORDS, COPIED_SCOPE_PATHS)
  const row = await InventoryRecord.findOne(within(visible, { _id: id })).lean<InventoryRecordDoc>()
  if (!row) throw notFound()
  return row
}

export async function requireRecord(scope: Scope, id: string): Promise<void> {
  await recordById(scope, id)
}

export async function getRecord(scope: Scope, id: string) {
  const [view] = await recordViews(scope, [await recordById(scope, id)])
  if (!view) throw notFound()
  return view
}

export async function listComments(scope: Scope, recordId: string) {
  await requireRecord(scope, recordId)
  const rows = await WorkflowComment.find({ inventoryRecordId: recordId })
    .sort({ number: 1 })
    .lean<WorkflowCommentDoc[]>()
  const authors = await User.find({
    _id: { $in: rows.flatMap((row) => (row.authorId ? [row.authorId] : [])) },
  }).lean()
  const authorName = new Map(
    authors.map((user) => [user._id, `${user.firstName} ${user.lastName}`.trim() || user.email]),
  )
  return rows.map((row) => ({
    id: row.number,
    action: row.action,
    body: row.body,
    author: row.authorId ? (authorName.get(row.authorId) ?? '') : '',
    created_at: row.createdAt.toISOString(),
  }))
}

// --- Official numbers

export interface StageTotal {
  municipalityId: string
  municipality: string
  stageCode: string
  stageLabel: string
  sortOrder: number
  count: number
  /** Exact, and rounded only for display. Null when the crop has no density or no area. */
  areaHa: Decimal | null
}

/** Official totals per municipality and stage for one round: approved or locked records only. */
export async function stageTotals(round: SurveyRoundDoc, scope: Scope): Promise<StageTotal[]> {
  const commodity = await Commodity.findOne({ _id: round.commodityId }).lean<CommodityDoc>()
  if (!commodity) return []
  const rows = await InventoryRecord.aggregate<{
    _id: { municipalityId: string; growthStageId: string }
    count: number
    area: Types.Decimal128 | number
    anyArea: Types.Decimal128 | null
  }>([
    {
      $match: {
        $and: [
          scopeFilter(scope, Cap.VIEW_AGGREGATES, COPIED_SCOPE_PATHS),
          {
            surveyRoundId: round._id,
            status: { $in: OFFICIAL_STATUSES },
            isDeleted: false,
          },
        ],
      },
    },
    { $unwind: '$stageCounts' },
    {
      $group: {
        _id: { municipalityId: '$municipalityId', growthStageId: '$stageCounts.growthStageId' },
        count: { $sum: { $ifNull: ['$stageCounts.count', 0] } },
        area: { $sum: { $ifNull: ['$stageCounts.areaHa', 0] } },
        anyArea: { $max: '$stageCounts.areaHa' },
      },
    },
  ])
  const [stages, towns] = await Promise.all([
    GrowthStage.find({
      _id: { $in: rows.map((row) => row._id.growthStageId) },
      isDeleted: { $in: [true, false] },
    }).lean<GrowthStageDoc[]>(),
    Municipality.find({ _id: { $in: rows.map((row) => row._id.municipalityId) } }).lean(),
  ])
  const stageById = byOwnId(stages)
  const townName = new Map(towns.map((town) => [town._id, town.name]))
  const density = plantsPerHa(commodity)
  const totals = rows.map((row) => {
    const stage = stageById.get(row._id.growthStageId)
    let areaHa: Decimal | null = null
    if (commodity.measureType === 'area') {
      areaHa = row.anyArea === null ? null : new HalfUp(row.area.toString())
    } else if (density) {
      areaHa = new HalfUp(row.count).dividedBy(density)
    }
    return {
      municipalityId: row._id.municipalityId,
      municipality: townName.get(row._id.municipalityId) ?? '',
      stageCode: stage?.code ?? '',
      stageLabel: stage?.label ?? '',
      sortOrder: stage?.sortOrder ?? 0,
      count: row.count,
      areaHa,
    }
  })
  return orderRows(
    totals,
    undefined,
    { town: (row) => row.municipality, order: (row) => row.sortOrder },
    ['town', 'order'],
  )
}

export async function roundTotals(scope: Scope, roundId: string) {
  const rows = await stageTotals(await roundById(scope, roundId), scope)
  return rows.map((row) => ({
    municipality_id: row.municipalityId,
    municipality: row.municipality,
    stage_code: row.stageCode,
    stage_label: row.stageLabel,
    sort_order: row.sortOrder,
    count: row.count,
    area_ha: row.areaHa?.toFixed(2) ?? null,
  }))
}

/** Per municipality: expected crop stands against records by status. Aggregate, with no names. */
export async function roundProgress(scope: Scope, roundId: string) {
  const round = await roundById(scope, roundId)
  const visible = scopeFilter(scope, Cap.VIEW_AGGREGATES, COPIED_SCOPE_PATHS)
  const [expected, byStatus] = await Promise.all([
    CropStand.aggregate<{ _id: string; n: number }>([
      { $match: { $and: [visible, { commodityId: round.commodityId, isDeleted: false }] } },
      { $group: { _id: '$municipalityId', n: { $sum: 1 } } },
    ]),
    InventoryRecord.aggregate<{ _id: { municipalityId: string; status: string }; n: number }>([
      { $match: { $and: [visible, { surveyRoundId: round._id, isDeleted: false }] } },
      {
        $group: {
          _id: { municipalityId: '$municipalityId', status: '$status' },
          n: { $sum: 1 },
        },
      },
    ]),
  ])
  const towns = await Municipality.find({ _id: { $in: expected.map((row) => row._id) } }).lean()
  const townName = new Map(towns.map((town) => [town._id, town.name]))
  const rows = expected.map((row) => {
    const statuses = RECORD_STATUSES.map((status) => {
      const match = byStatus.find(
        (item) => item._id.municipalityId === row._id && item._id.status === status,
      )
      return [status, match?.n ?? 0] as const
    })
    return {
      municipality_id: row._id,
      municipality: townName.get(row._id) ?? '',
      expected: row.n,
      ...(Object.fromEntries(statuses) as Record<(typeof RECORD_STATUSES)[number], number>),
    }
  })
  return orderRows(rows, undefined, { town: (row) => row.municipality }, ['town'])
}

export async function latestOfficialRound(commodityId: string): Promise<SurveyRoundDoc | null> {
  const rounds = await SurveyRound.find({ commodityId })
    .sort({ asOfDate: -1 })
    .lean<SurveyRoundDoc[]>()
  for (const round of rounds) {
    const official = await InventoryRecord.exists({
      surveyRoundId: round._id,
      status: { $in: OFFICIAL_STATUSES },
    })
    if (official) return round
  }
  return null
}

/** Headline numbers for the home page, limited to the user's scope. */
export async function homeStats(scope: Scope) {
  const [farmers, farms, commodityRows] = await Promise.all([
    Farmer.countDocuments(scopeFilter(scope, Cap.VIEW_AGGREGATES, FARMER_SCOPE)),
    Farm.countDocuments(scopeFilter(scope, Cap.VIEW_AGGREGATES, FARM_SCOPE)),
    Commodity.find().lean<CommodityDoc[]>(),
  ])
  const commodities = []
  for (const commodity of orderRows(commodityRows, undefined, { name: (row) => row.name }, [
    'name',
  ])) {
    const round = await latestOfficialRound(commodity._id)
    if (!round) continue
    const totals = await stageTotals(round, scope)
    const stageRows = await GrowthStage.find({ commodityId: commodity._id })
      .sort({ sortOrder: 1 })
      .lean<GrowthStageDoc[]>()
    const stages = stageRows.map((stage) => {
      const matching = totals.filter((row) => row.stageCode === stage.code)
      const area = matching.reduce((sum, row) => sum.plus(row.areaHa ?? 0), new HalfUp(0))
      return {
        code: stage.code,
        label: stage.label,
        count: matching.reduce((sum, row) => sum + row.count, 0),
        rounded: new HalfUp(area.toFixed(2)),
      }
    })
    commodities.push({
      commodity: { id: commodity._id, code: commodity.code, name: commodity.name },
      round: { id: round._id, name: round.name },
      stages: stages.map(({ rounded, ...stage }) => ({ ...stage, area_ha: rounded.toFixed(2) })),
      total: stages.reduce((sum, stage) => sum + stage.count, 0),
      total_area_ha: stages
        .reduce((sum, stage) => sum.plus(stage.rounded), new HalfUp(0))
        .toFixed(2),
    })
  }
  return { farmers, farms, commodities }
}
