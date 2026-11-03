/**
 * MongoDB has no foreign keys, so this looks for broken references and copied keys that disagree with
 * their source (ADR-0019). It reports ids only, never field values, so its output holds no personal
 * data. Soft-deleted rows are not checked, because they may legitimately point at retired parents.
 */
import type { Model } from 'mongoose'

import {
  Commodity,
  GrowthStage,
  MaterialSource,
  Program,
  Variety,
} from '../models/catalog.models.js'
import { CropStand, Farm, Harvest, Planting } from '../models/farm.models.js'
import { Barangay, Municipality } from '../models/location.models.js'
import { Association, AssociationMember, Farmer } from '../models/registry.models.js'
import { InventoryRecord, SurveyRound, WorkflowComment } from '../models/survey.models.js'

export interface IntegrityProblem {
  check: string
  count: number
  /** Up to 10 affected ids, enough to start looking. */
  sampleIds: string[]
}

const SAMPLE_SIZE = 10

type Row = Record<string, unknown> & { _id: string }

async function aliveRows(model: Model<never>): Promise<Row[]> {
  return model.find({}).lean<Row[]>()
}

function asModel(model: unknown): Model<never> {
  return model as Model<never>
}

export async function integrityProblems(): Promise<IntegrityProblem[]> {
  const load = (model: unknown) => aliveRows(asModel(model))
  const [
    municipalities,
    barangays,
    programs,
    commodities,
    stages,
    varieties,
    sources,
    farmers,
    associations,
    members,
    farms,
    stands,
    plantings,
    harvests,
    rounds,
    records,
    comments,
  ] = await Promise.all([
    load(Municipality),
    load(Barangay),
    load(Program),
    load(Commodity),
    load(GrowthStage),
    load(Variety),
    load(MaterialSource),
    load(Farmer),
    load(Association),
    load(AssociationMember),
    load(Farm),
    load(CropStand),
    load(Planting),
    load(Harvest),
    load(SurveyRound),
    load(InventoryRecord),
    load(WorkflowComment),
  ])

  const index = (rows: Row[]) => new Map(rows.map((row) => [row._id, row]))
  const barangayById = index(barangays)
  const commodityById = index(commodities)
  const farmById = index(farms)
  const standById = index(stands)
  const varietyById = index(varieties)
  const municipalityIds = index(municipalities)
  const programIds = index(programs)
  const sourceIds = index(sources)
  const farmerIds = index(farmers)
  const associationIds = index(associations)

  const problems: IntegrityProblem[] = []
  const report = (check: string, rows: Row[], isBad: (row: Row) => boolean): void => {
    const bad = rows.filter(isBad)
    if (bad.length > 0) {
      problems.push({
        check,
        count: bad.length,
        sampleIds: bad.slice(0, SAMPLE_SIZE).map((row) => row._id),
      })
    }
  }
  const missing = (parents: Map<string, Row>, field: string) => (row: Row) =>
    !parents.has(row[field] as string)

  report('barangay.municipality', barangays, missing(municipalityIds, 'municipalityId'))
  report('commodity.program', commodities, missing(programIds, 'programId'))
  report('growth_stage.commodity', stages, missing(commodityById, 'commodityId'))
  report('variety.commodity', varieties, missing(commodityById, 'commodityId'))

  report('farmer.home_barangay', farmers, missing(barangayById, 'homeBarangayId'))
  report('farmer.municipality_key', farmers, (row) => {
    const barangay = barangayById.get(row.homeBarangayId as string)
    return barangay !== undefined && barangay.municipalityId !== row.municipalityId
  })
  report('association.municipality', associations, missing(municipalityIds, 'municipalityId'))
  report('member.farmer', members, missing(farmerIds, 'farmerId'))
  report('member.association', members, missing(associationIds, 'associationId'))

  report('farm.farmer', farms, missing(farmerIds, 'farmerId'))
  report('farm.barangay', farms, missing(barangayById, 'barangayId'))
  report('farm.municipality_key', farms, (row) => {
    const barangay = barangayById.get(row.barangayId as string)
    return barangay !== undefined && barangay.municipalityId !== row.municipalityId
  })

  report('crop_stand.farm', stands, missing(farmById, 'farmId'))
  report('crop_stand.commodity', stands, missing(commodityById, 'commodityId'))
  const keysDiffer = (parent: Row | undefined, row: Row) =>
    parent !== undefined &&
    (parent.barangayId !== row.barangayId || parent.municipalityId !== row.municipalityId)
  report('crop_stand.location_keys', stands, (row) =>
    keysDiffer(farmById.get(row.farmId as string), row),
  )
  report('crop_stand.program_key', stands, (row) => {
    const commodity = commodityById.get(row.commodityId as string)
    return commodity !== undefined && commodity.programId !== row.programId
  })

  for (const [name, rows] of [
    ['planting', plantings],
    ['harvest', harvests],
  ] as const) {
    report(`${name}.crop_stand`, rows, missing(standById, 'cropStandId'))
    report(`${name}.scope_keys`, rows, (row) => {
      const stand = standById.get(row.cropStandId as string)
      return keysDiffer(stand, row) || (stand !== undefined && stand.programId !== row.programId)
    })
  }
  report('planting.source', plantings, (row) => {
    return row.sourceId !== null && !sourceIds.has(row.sourceId as string)
  })
  report('planting.varieties', plantings, (row) => {
    const stand = standById.get(row.cropStandId as string)
    return (row.varietyIds as string[]).some((id) => {
      const variety = varietyById.get(id)
      if (variety === undefined) return true
      return stand !== undefined && variety.commodityId !== stand.commodityId
    })
  })
  const roundById = index(rounds)
  report('survey_round.commodity', rounds, missing(commodityById, 'commodityId'))
  report('survey_round.program_key', rounds, (row) => {
    const commodity = commodityById.get(row.commodityId as string)
    return commodity !== undefined && commodity.programId !== row.programId
  })
  report('inventory_record.round', records, missing(roundById, 'surveyRoundId'))
  report('inventory_record.crop_stand', records, missing(standById, 'cropStandId'))
  report('inventory_record.scope_keys', records, (row) => {
    const stand = standById.get(row.cropStandId as string)
    return keysDiffer(stand, row) || (stand !== undefined && stand.programId !== row.programId)
  })
  report('inventory_record.commodity', records, (row) => {
    const stand = standById.get(row.cropStandId as string)
    const round = roundById.get(row.surveyRoundId as string)
    return stand !== undefined && round !== undefined && stand.commodityId !== round.commodityId
  })
  const stageById = index(stages)
  report('inventory_record.stages', records, (row) => {
    const stand = standById.get(row.cropStandId as string)
    return (row.stageCounts as { growthStageId: string }[]).some(({ growthStageId }) => {
      const stage = stageById.get(growthStageId)
      if (stage === undefined) return true
      return stand !== undefined && stage.commodityId !== stand.commodityId
    })
  })
  report('comment.record', comments, missing(index(records), 'inventoryRecordId'))
  return problems
}
