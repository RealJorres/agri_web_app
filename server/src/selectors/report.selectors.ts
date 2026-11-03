/**
 * Report content: plain data built from official records, so a report is always the authoritative
 * figure. Renderers only lay it out. Sign-off hashes this content, not a file (ADR-0015), because
 * files embed timestamps and library versions.
 */
import { createHash } from 'node:crypto'

import { Decimal } from 'decimal.js'
import type { ClientSession } from 'mongoose'

import { dateOnly } from '../lib/dates.js'
import { HalfUp } from '../lib/decimal.js'
import { notFound } from '../lib/errors.js'
import { orderRows } from '../lib/ordering.js'
import { readPrivateFile } from '../lib/privateFiles.js'
import { Cap } from '../lib/roles.js'
import { COPIED_SCOPE_PATHS, scopeFilter, within, type Scope } from '../lib/scoping.js'
import {
  Commodity,
  type CommodityDoc,
  GrowthStage,
  type GrowthStageDoc,
  MaterialSource,
  type MaterialSourceDoc,
  Variety,
  type VarietyDoc,
} from '../models/catalog.models.js'
import {
  CropStand,
  type CropStandDoc,
  Farm,
  type FarmDoc,
  Planting,
  type PlantingDoc,
} from '../models/farm.models.js'
import { Barangay, Municipality, type BarangayDoc } from '../models/location.models.js'
import {
  Association,
  type AssociationDoc,
  AssociationMember,
  type AssociationMemberDoc,
  Farmer,
  farmerDisplayName,
  type FarmerDoc,
} from '../models/registry.models.js'
import {
  DEFAULT_LETTERHEAD,
  DEFAULT_PROGRAM_LINE,
  ReportSettings,
  type ReportKind,
  Signatory,
  type SignatoryDoc,
} from '../models/report.models.js'
import {
  InventoryRecord,
  type InventoryRecordDoc,
  OFFICIAL_STATUSES,
  type SurveyRoundDoc,
} from '../models/survey.models.js'
import { officialFacts } from './analytics.selectors.js'
import { plantsPerHa } from './catalog.selectors.js'

/** The 2023 SUMMARY sheet shows area to 3 decimals. */
const AREA_PLACES = 3

export interface ReportCommon {
  kind: ReportKind
  letterhead: string[]
  program_line: string
  round: { id: string; name: string; as_of: string }
  commodity: string
  final: boolean
  signatories: { caption: string; name: string; title: string }[]
}

async function commonContent(
  round: SurveyRoundDoc,
  commodity: CommodityDoc,
  kind: ReportKind,
  session?: ClientSession,
): Promise<ReportCommon> {
  const [settings, signatories] = await Promise.all([
    ReportSettings.findOne({ _id: 'current' })
      .session(session ?? null)
      .lean(),
    Signatory.find({ reportKind: kind })
      .sort({ order: 1 })
      .session(session ?? null)
      .lean<SignatoryDoc[]>(),
  ])
  return {
    kind,
    letterhead: (settings?.letterhead ?? DEFAULT_LETTERHEAD)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
    program_line: settings?.programLine ?? DEFAULT_PROGRAM_LINE,
    round: { id: round._id, name: round.name, as_of: dateOnly(round.asOfDate) ?? '' },
    commodity: commodity.name,
    final: round.status === 'closed',
    signatories: signatories.map(({ caption, name, title }) => ({ caption, name, title })),
  }
}

/** The uploaded logo for PDFs. A missing file is not worth failing a report over. */
export async function reportLogo(): Promise<Buffer | null> {
  const settings = await ReportSettings.findOne({ _id: 'current' }).lean()
  if (!settings?.logoPath) return null
  return readPrivateFile(settings.logoPath).catch(() => null)
}

function areaText(trees: number, density: number | null): string | null {
  return density ? new HalfUp(trees).dividedBy(density).toFixed(AREA_PLACES) : null
}

export interface SummaryRow {
  municipality: string
  farmers: number
  trees: number[]
  trees_total: number
  area: (string | null)[]
  area_total: string | null
}

export interface SummaryContent extends ReportCommon {
  stages: string[]
  rows: SummaryRow[]
  total: Omit<SummaryRow, 'municipality'>
  density_note: string
}

/** The provincial summary, in the layout of the 2023 SUMMARY sheet. */
export async function summaryContent(
  round: SurveyRoundDoc,
  scope: Scope,
  session?: ClientSession,
): Promise<SummaryContent> {
  const commodity = await Commodity.findOne({ _id: round.commodityId })
    .session(session ?? null)
    .lean<CommodityDoc>()
  if (!commodity) throw notFound()
  const density = plantsPerHa(commodity)
  const stages = await GrowthStage.find({ commodityId: commodity._id })
    .sort({ sortOrder: 1 })
    .session(session ?? null)
    .lean<GrowthStageDoc[]>()
  const facts = await officialFacts(round, scope, {}, session)
  const towns = await Municipality.find({
    _id: { $in: facts.map((fact) => fact.municipalityId) },
  })
    .session(session ?? null)
    .lean()

  const rows: SummaryRow[] = towns
    // A town whose records hold no stage counts has nothing to report.
    .filter((town) => {
      return facts.some((fact) => fact.municipalityId === town._id && fact.hasStageCounts)
    })
    .map((town) => {
      const own = facts.filter((fact) => fact.municipalityId === town._id)
      const trees = stages.map((stage) =>
        own.reduce((sum, fact) => sum + (fact.stages[stage.code] ?? 0), 0),
      )
      const total = trees.reduce((sum, count) => sum + count, 0)
      return {
        municipality: town.name,
        // "No. of farmers" as ADR-0015 defines it: distinct farmers with a tree counted on a record.
        farmers: new Set(own.filter((fact) => fact.trees > 0).map((fact) => fact.farmerId)).size,
        trees,
        trees_total: total,
        area: trees.map((count) => areaText(count, density)),
        area_total: areaText(total, density),
      }
    })
  const ordered = orderRows(rows, undefined, { town: (row) => row.municipality }, ['town'])
  const totalTrees = stages.map((_, index) =>
    ordered.reduce((sum, row) => sum + (row.trees[index] ?? 0), 0),
  )
  const grandTotal = totalTrees.reduce((sum, count) => sum + count, 0)
  const spacing = commodity.spacingM ? new Decimal(commodity.spacingM.toString()).toString() : ''
  const crop = commodity.name.toLowerCase()
  const densityNote = density
    ? `${Math.trunc(density).toLocaleString('en-US')} ${crop} trees/hectare` +
      (spacing ? ` with ${spacing}x${spacing} planting distance` : '')
    : ''
  return {
    ...(await commonContent(round, commodity, 'summary', session)),
    stages: stages.map((stage) => stage.label),
    rows: ordered,
    total: {
      farmers: ordered.reduce((sum, row) => sum + row.farmers, 0),
      trees: totalTrees,
      trees_total: grandTotal,
      area: totalTrees.map((count) => areaText(count, density)),
      area_total: areaText(grandTotal, density),
    },
    density_note: densityNote,
  }
}

export interface MunicipalRow {
  no: number
  name: string
  barangay: string
  farm_location: string
  association: string
  contact: string
  variety: string
  planted: string
  source: string
  counts: (number | null)[]
  remarks: string
}

export interface MunicipalContent extends ReportCommon {
  municipality: string
  stages: string[]
  rows: MunicipalRow[]
  totals: number[]
}

/** The farmer-level list for one municipality. Personal data: callers check the capability. */
export async function municipalListContent(
  round: SurveyRoundDoc,
  scope: Scope,
  municipalityId: string,
): Promise<MunicipalContent> {
  const [commodity, town, stages] = await Promise.all([
    Commodity.findOne({ _id: round.commodityId }).lean<CommodityDoc>(),
    Municipality.findOne({ _id: municipalityId }).lean(),
    GrowthStage.find({ commodityId: round.commodityId })
      .sort({ sortOrder: 1 })
      .lean<GrowthStageDoc[]>(),
  ])
  if (!commodity || !town) throw notFound()
  const records = await InventoryRecord.find(
    within(scopeFilter(scope, Cap.VIEW_RECORDS, COPIED_SCOPE_PATHS), {
      surveyRoundId: round._id,
      status: { $in: OFFICIAL_STATUSES },
      municipalityId,
    }),
  ).lean<InventoryRecordDoc[]>()
  const stands = await CropStand.find({
    _id: { $in: records.map((record) => record.cropStandId) },
    isDeleted: { $in: [true, false] },
  }).lean<CropStandDoc[]>()
  const farms = await Farm.find({
    _id: { $in: stands.map((stand) => stand.farmId) },
    isDeleted: { $in: [true, false] },
  }).lean<FarmDoc[]>()
  const farmers = await Farmer.find({
    _id: { $in: farms.map((farm) => farm.farmerId) },
    isDeleted: { $in: [true, false] },
  }).lean<FarmerDoc[]>()
  const [barangays, plantings, members] = await Promise.all([
    Barangay.find({
      _id: {
        $in: [
          ...farms.map((farm) => farm.barangayId),
          ...farmers.map((farmer) => farmer.homeBarangayId),
        ],
      },
    }).lean<BarangayDoc[]>(),
    Planting.find({ cropStandId: { $in: stands.map((stand) => stand._id) } }).lean<PlantingDoc[]>(),
    AssociationMember.find({ farmerId: { $in: farmers.map((farmer) => farmer._id) } }).lean<
      AssociationMemberDoc[]
    >(),
  ])
  const [varieties, sources, associations] = await Promise.all([
    Variety.find({ _id: { $in: plantings.flatMap((row) => row.varietyIds) } }).lean<VarietyDoc[]>(),
    MaterialSource.find({
      _id: { $in: plantings.flatMap((row) => row.sourceId ?? []) },
    }).lean<MaterialSourceDoc[]>(),
    Association.find({ _id: { $in: members.map((row) => row.associationId) } }).lean<
      AssociationDoc[]
    >(),
  ])
  const index = <Row extends { _id: string }>(rows: Row[]) =>
    new Map(rows.map((row) => [row._id, row]))
  const standById = index(stands)
  const farmById = index(farms)
  const farmerById = index(farmers)
  const barangayById = index(barangays)
  const varietyById = index(varieties)
  const sourceById = index(sources)
  const associationById = index(associations)
  const sortedText = (values: Iterable<string>) => [...new Set(values)].sort().join(', ')

  const farmerOf = (record: InventoryRecordDoc) => {
    const stand = standById.get(record.cropStandId)
    const farm = stand && farmById.get(stand.farmId)
    return farm && farmerById.get(farm.farmerId)
  }
  const ordered = orderRows(
    records,
    undefined,
    {
      last: (record) => farmerOf(record)?.lastName ?? null,
      first: (record) => farmerOf(record)?.firstName ?? null,
    },
    ['last', 'first'],
  )
  const rows: MunicipalRow[] = ordered.map((record, position) => {
    const stand = standById.get(record.cropStandId)
    const farm = stand && farmById.get(stand.farmId)
    const farmer = farm && farmerById.get(farm.farmerId)
    const own = plantings.filter((row) => row.cropStandId === record.cropStandId)
    const countOf = new Map(record.stageCounts.map((row) => [row.growthStageId, row.count]))
    return {
      no: position + 1,
      name: farmer ? farmerDisplayName(farmer) : '',
      barangay: farmer ? (barangayById.get(farmer.homeBarangayId)?.name ?? '') : '',
      farm_location: farm ? (barangayById.get(farm.barangayId)?.name ?? '') : '',
      association: members
        .filter((row) => row.farmerId === farmer?._id)
        .map((row) => associationById.get(row.associationId)?.name ?? '')
        .join(', '),
      contact: farmer?.contactNo ?? '',
      variety: sortedText(
        own.flatMap((row) => row.varietyIds.map((id) => varietyById.get(id)?.code ?? '')),
      ),
      planted: [...new Set(own.flatMap((row) => row.yearPlanted ?? []))]
        .sort((a, b) => a - b)
        .join(', '),
      source: sortedText(own.flatMap((row) => sourceById.get(row.sourceId ?? '')?.name ?? [])),
      counts: stages.map((stage) => countOf.get(stage._id) ?? null),
      remarks: record.remarks,
    }
  })
  return {
    ...(await commonContent(round, commodity, 'municipal_list')),
    municipality: town.name,
    stages: stages.map((stage) => stage.label),
    rows,
    totals: stages.map((_, column) =>
      rows.reduce((sum, row) => sum + (row.counts[column] ?? 0), 0),
    ),
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== 'object' || value === null) return value
  const entries = Object.entries(value as Record<string, unknown>)
  entries.sort(([a], [b]) => (a < b ? -1 : 1))
  return Object.fromEntries(entries.map(([key, inner]) => [key, canonical(inner)]))
}

/** SHA-256 of the canonical content (ADR-0015). Draft or final state is not part of it. */
export function contentHash(content: ReportCommon): string {
  const hashed = Object.entries(content).filter(([key]) => key !== 'final')
  return createHash('sha256')
    .update(JSON.stringify(canonical(Object.fromEntries(hashed))))
    .digest('hex')
}
