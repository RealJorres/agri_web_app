/**
 * Administrators' changes to the catalog. New crops are rows here, not code (brief §1). A code never
 * changes once created, and anything records already point at can be renamed but not removed.
 */
import type { ClientSession, Model } from 'mongoose'

import { decimalString, toDecimal128 } from '../lib/decimal.js'
import { DomainError, notFound } from '../lib/errors.js'
import { isDuplicateKey } from '../lib/mongoErrors.js'
import { collapseSpaces, normalizeCode } from '../lib/text.js'
import { inTransaction } from '../lib/transaction.js'
import { markDeleted, type BaseDoc } from '../models/base.js'
import {
  Commodity,
  GrowthStage,
  MaterialSource,
  Program,
  Variety,
  type CommodityDoc,
  type GrowthStageDoc,
  type MaterialSourceDoc,
  type MeasureType,
  type ProgramDoc,
  type VarietyDoc,
} from '../models/catalog.models.js'
import { CropStand, Planting } from '../models/farm.models.js'
import { InventoryRecord, SurveyRound } from '../models/survey.models.js'
import { AliasConflictError, AliasIndex } from '../selectors/catalog.selectors.js'
import { recordAudit } from './audit.service.js'
import { checkAttributesSchema } from './catalog.service.js'

type ActorId = string

function codeTaken(error: unknown, fields: Record<string, string>): DomainError | null {
  for (const [field, message] of Object.entries(fields)) {
    if (isDuplicateKey(error, field)) {
      return new DomainError('duplicate', message, { [snake(field)]: [message] })
    }
  }
  return null
}

function snake(field: string): string {
  return field.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)
}

/** Runs a write, turning a unique-index failure into a message about the field. */
async function saving<T>(fields: Record<string, string>, write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    throw codeTaken(error, fields) ?? error
  }
}

/** Trims, and drops blanks and spellings that normalize to the same thing. */
export function cleanAliases(aliases: readonly string[] | undefined): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const alias of aliases ?? []) {
    const value = collapseSpaces(alias)
    const key = normalizeCode(value)
    if (key && !seen.has(key)) {
      seen.add(key)
      result.push(value)
    }
  }
  return result
}

/** An ambiguous spelling would make imports guess, so it is refused when it is entered. */
function requireUnambiguous(rows: ConstructorParameters<typeof AliasIndex>[0]): void {
  try {
    new AliasIndex(rows)
  } catch (error) {
    if (!(error instanceof AliasConflictError)) throw error
    throw new DomainError('alias_conflict', 'Two entries would share the same spelling.', {
      aliases: [error.message],
    })
  }
}

async function loadOrFail<Doc extends BaseDoc>(
  model: Model<Doc>,
  id: string,
  session: ClientSession,
) {
  const doc = await model.findOne({ _id: id } as never).session(session)
  if (!doc) throw notFound()
  return doc
}

// --- Programs

export async function createProgram(input: {
  actorId: ActorId
  code: string
  name: string
}): Promise<ProgramDoc> {
  return saving({ code: 'This code is already used.' }, () =>
    inTransaction(async (session) => {
      const program = new Program({
        code: input.code,
        name: input.name,
        createdBy: input.actorId,
        updatedBy: input.actorId,
      })
      await program.save({ session })
      await recordAudit({
        actorId: input.actorId,
        action: 'program.create',
        objectType: 'program',
        objectId: program._id,
        after: { code: program.code, name: program.name },
        session,
      })
      return program.toObject()
    }),
  )
}

export async function updateProgram(input: {
  actorId: ActorId
  id: string
  name: string
}): Promise<ProgramDoc> {
  return inTransaction(async (session) => {
    const program = await loadOrFail(Program, input.id, session)
    const before = program.name
    program.name = input.name
    program.updatedBy = input.actorId
    await program.save({ session })
    await recordAudit({
      actorId: input.actorId,
      action: 'program.update',
      objectType: 'program',
      objectId: program._id,
      before: { name: before },
      after: { name: input.name },
      session,
    })
    return program.toObject()
  })
}

// --- Commodities

export interface CommodityUsage {
  crop_stands: number
  rounds: number
}

export async function commodityUsage(id: string, session?: ClientSession): Promise<CommodityUsage> {
  const [cropStands, rounds] = await Promise.all([
    CropStand.countDocuments({ commodityId: id }).session(session ?? null),
    SurveyRound.countDocuments({ commodityId: id }).session(session ?? null),
  ])
  return { crop_stands: cropStands, rounds }
}

async function requireProgram(id: string, session: ClientSession): Promise<void> {
  if (!(await Program.exists({ _id: id }).session(session))) {
    throw new DomainError('invalid_program', 'Choose a program.', { program: ['Not found.'] })
  }
}

function commodityAudit(doc: CommodityDoc) {
  return {
    code: doc.code,
    name: doc.name,
    programId: doc.programId,
    measureType: doc.measureType,
    spacingM: decimalString(doc.spacingM, 2),
    plantsPerHa: doc.plantsPerHa,
    outlierMultiplier: decimalString(doc.outlierMultiplier, 2),
    attributesSchema: doc.attributesSchema,
  }
}

export async function createCommodity(input: {
  actorId: ActorId
  programId: string
  code: string
  name: string
  measureType: MeasureType
  spacingM?: string | null | undefined
  plantsPerHa?: number | null | undefined
  outlierMultiplier?: string | undefined
  attributesSchema?: Record<string, unknown> | undefined
}): Promise<string> {
  checkAttributesSchema(input.attributesSchema ?? {})
  return saving({ code: 'This code is already used.' }, () =>
    inTransaction(async (session) => {
      await requireProgram(input.programId, session)
      const commodity = new Commodity({
        programId: input.programId,
        code: input.code,
        name: input.name,
        measureType: input.measureType,
        spacingM: input.spacingM ? toDecimal128(input.spacingM) : null,
        plantsPerHa: input.plantsPerHa ?? null,
        outlierMultiplier: toDecimal128(input.outlierMultiplier ?? '5'),
        attributesSchema: input.attributesSchema ?? {},
        createdBy: input.actorId,
        updatedBy: input.actorId,
      })
      await commodity.save({ session })
      await recordAudit({
        actorId: input.actorId,
        action: 'commodity.create',
        objectType: 'commodity',
        objectId: commodity._id,
        after: commodityAudit(commodity.toObject()),
        session,
      })
      return commodity._id
    }),
  )
}

export async function updateCommodity(input: {
  actorId: ActorId
  id: string
  programId?: string | undefined
  name?: string | undefined
  measureType?: MeasureType | undefined
  spacingM?: string | null | undefined
  plantsPerHa?: number | null | undefined
  outlierMultiplier?: string | undefined
  attributesSchema?: Record<string, unknown> | undefined
}): Promise<void> {
  if (input.attributesSchema) checkAttributesSchema(input.attributesSchema)
  await inTransaction(async (session) => {
    const commodity = await loadOrFail(Commodity, input.id, session)
    const before = commodityAudit(commodity.toObject())
    const movesProgram = input.programId !== undefined && input.programId !== commodity.programId
    const changesMeasure =
      input.measureType !== undefined && input.measureType !== commodity.measureType
    if (movesProgram || changesMeasure) {
      const usage = await commodityUsage(input.id, session)
      if (usage.crop_stands > 0 || usage.rounds > 0) {
        // Crop stands and rounds copy the program key, and their counts assume the measure.
        const field = movesProgram ? 'program' : 'measure_type'
        const message = 'This cannot change once the crop has crop stands or survey rounds.'
        throw new DomainError('commodity_in_use', message, { [field]: [message] }, 409)
      }
    }
    if (input.programId !== undefined) {
      await requireProgram(input.programId, session)
      commodity.programId = input.programId
    }
    if (input.name !== undefined) commodity.name = input.name
    if (input.measureType !== undefined) commodity.measureType = input.measureType
    if (input.spacingM !== undefined) {
      commodity.spacingM = input.spacingM ? toDecimal128(input.spacingM) : null
    }
    if (input.plantsPerHa !== undefined) commodity.plantsPerHa = input.plantsPerHa
    if (input.outlierMultiplier !== undefined) {
      commodity.outlierMultiplier = toDecimal128(input.outlierMultiplier)
    }
    if (input.attributesSchema !== undefined) {
      commodity.attributesSchema = input.attributesSchema
      commodity.markModified('attributesSchema')
    }
    commodity.updatedBy = input.actorId
    await commodity.save({ session })
    await recordAudit({
      actorId: input.actorId,
      action: 'commodity.update',
      objectType: 'commodity',
      objectId: commodity._id,
      before,
      after: commodityAudit(commodity.toObject()),
      session,
    })
  })
}

// --- Growth stages

const STAGE_TAKEN = {
  code: 'This crop already has a stage with this code.',
  sortOrder: 'This crop already has a stage in this position.',
}

function stageAudit(stage: GrowthStageDoc) {
  return {
    code: stage.code,
    label: stage.label,
    sortOrder: stage.sortOrder,
    isBearing: stage.isBearing,
    aliases: stage.aliases,
  }
}

async function checkStageSpellings(commodityId: string, session: ClientSession): Promise<void> {
  requireUnambiguous(await GrowthStage.find({ commodityId }).session(session).lean())
}

export async function createStage(input: {
  actorId: ActorId
  commodityId: string
  code: string
  label: string
  sortOrder: number
  isBearing?: boolean | undefined
  aliases?: string[] | undefined
}): Promise<GrowthStageDoc> {
  return saving(STAGE_TAKEN, () =>
    inTransaction(async (session) => {
      if (!(await Commodity.exists({ _id: input.commodityId }).session(session))) throw notFound()
      const stage = new GrowthStage({
        commodityId: input.commodityId,
        code: input.code,
        label: input.label,
        sortOrder: input.sortOrder,
        isBearing: input.isBearing ?? false,
        aliases: cleanAliases(input.aliases),
        createdBy: input.actorId,
        updatedBy: input.actorId,
      })
      await stage.save({ session })
      await checkStageSpellings(input.commodityId, session)
      await recordAudit({
        actorId: input.actorId,
        action: 'growth_stage.create',
        objectType: 'growth_stage',
        objectId: stage._id,
        after: stageAudit(stage.toObject()),
        session,
      })
      return stage.toObject()
    }),
  )
}

export async function updateStage(input: {
  actorId: ActorId
  id: string
  label?: string | undefined
  sortOrder?: number | undefined
  isBearing?: boolean | undefined
  aliases?: string[] | undefined
}): Promise<GrowthStageDoc> {
  return saving(STAGE_TAKEN, () =>
    inTransaction(async (session) => {
      const stage = await loadOrFail(GrowthStage, input.id, session)
      const before = stageAudit(stage.toObject())
      if (input.label !== undefined) stage.label = input.label
      if (input.sortOrder !== undefined) stage.sortOrder = input.sortOrder
      if (input.isBearing !== undefined) stage.isBearing = input.isBearing
      if (input.aliases !== undefined) stage.aliases = cleanAliases(input.aliases)
      stage.updatedBy = input.actorId
      await stage.save({ session })
      await checkStageSpellings(stage.commodityId, session)
      await recordAudit({
        actorId: input.actorId,
        action: 'growth_stage.update',
        objectType: 'growth_stage',
        objectId: stage._id,
        before,
        after: stageAudit(stage.toObject()),
        session,
      })
      return stage.toObject()
    }),
  )
}

function inUse(what: string): DomainError {
  return new DomainError(
    'in_use',
    `${what} is used by existing records, so it cannot be removed.`,
    {},
    409,
  )
}

export async function deleteStage(input: { actorId: ActorId; id: string }): Promise<void> {
  await inTransaction(async (session) => {
    const stage = await loadOrFail(GrowthStage, input.id, session)
    const used = await InventoryRecord.exists({ 'stageCounts.growthStageId': stage._id }).session(
      session,
    )
    if (used) throw inUse('This stage')
    markDeleted(stage, input.actorId)
    await stage.save({ session })
    await recordAudit({
      actorId: input.actorId,
      action: 'growth_stage.delete',
      objectType: 'growth_stage',
      objectId: stage._id,
      before: stageAudit(stage.toObject()),
      session,
    })
  })
}

// --- Varieties

const VARIETY_TAKEN = { code: 'This crop already has a variety with this code.' }

function varietyAudit(variety: VarietyDoc) {
  return { code: variety.code, name: variety.name, aliases: variety.aliases }
}

export async function createVariety(input: {
  actorId: ActorId
  commodityId: string
  code: string
  name: string
  aliases?: string[] | undefined
}): Promise<VarietyDoc> {
  return saving(VARIETY_TAKEN, () =>
    inTransaction(async (session) => {
      if (!(await Commodity.exists({ _id: input.commodityId }).session(session))) {
        throw new DomainError('invalid_commodity', 'Choose a crop.', { commodity: ['Not found.'] })
      }
      const variety = new Variety({
        commodityId: input.commodityId,
        code: input.code,
        name: input.name,
        aliases: cleanAliases(input.aliases),
        createdBy: input.actorId,
        updatedBy: input.actorId,
      })
      await variety.save({ session })
      requireUnambiguous(
        await Variety.find({ commodityId: input.commodityId }).session(session).lean(),
      )
      await recordAudit({
        actorId: input.actorId,
        action: 'variety.create',
        objectType: 'variety',
        objectId: variety._id,
        after: varietyAudit(variety.toObject()),
        session,
      })
      return variety.toObject()
    }),
  )
}

export async function updateVariety(input: {
  actorId: ActorId
  id: string
  name?: string | undefined
  aliases?: string[] | undefined
}): Promise<VarietyDoc> {
  return inTransaction(async (session) => {
    const variety = await loadOrFail(Variety, input.id, session)
    const before = varietyAudit(variety.toObject())
    if (input.name !== undefined) variety.name = input.name
    if (input.aliases !== undefined) variety.aliases = cleanAliases(input.aliases)
    variety.updatedBy = input.actorId
    await variety.save({ session })
    requireUnambiguous(
      await Variety.find({ commodityId: variety.commodityId }).session(session).lean(),
    )
    await recordAudit({
      actorId: input.actorId,
      action: 'variety.update',
      objectType: 'variety',
      objectId: variety._id,
      before,
      after: varietyAudit(variety.toObject()),
      session,
    })
    return variety.toObject()
  })
}

export async function deleteVariety(input: { actorId: ActorId; id: string }): Promise<void> {
  await inTransaction(async (session) => {
    const variety = await loadOrFail(Variety, input.id, session)
    if (await Planting.exists({ varietyIds: variety._id }).session(session)) {
      throw inUse('This variety')
    }
    markDeleted(variety, input.actorId)
    await variety.save({ session })
    await recordAudit({
      actorId: input.actorId,
      action: 'variety.delete',
      objectType: 'variety',
      objectId: variety._id,
      before: varietyAudit(variety.toObject()),
      session,
    })
  })
}

// --- Material sources

function sourceAudit(source: MaterialSourceDoc) {
  return { code: source.code, name: source.name, aliases: source.aliases }
}

export async function createSource(input: {
  actorId: ActorId
  code: string
  name: string
  aliases?: string[] | undefined
}): Promise<MaterialSourceDoc> {
  return saving({ code: 'This code is already used.' }, () =>
    inTransaction(async (session) => {
      const source = new MaterialSource({
        code: input.code,
        name: input.name,
        aliases: cleanAliases(input.aliases),
        createdBy: input.actorId,
        updatedBy: input.actorId,
      })
      await source.save({ session })
      requireUnambiguous(await MaterialSource.find().session(session).lean())
      await recordAudit({
        actorId: input.actorId,
        action: 'material_source.create',
        objectType: 'material_source',
        objectId: source._id,
        after: sourceAudit(source.toObject()),
        session,
      })
      return source.toObject()
    }),
  )
}

export async function updateSource(input: {
  actorId: ActorId
  id: string
  name?: string | undefined
  aliases?: string[] | undefined
}): Promise<MaterialSourceDoc> {
  return inTransaction(async (session) => {
    const source = await loadOrFail(MaterialSource, input.id, session)
    const before = sourceAudit(source.toObject())
    if (input.name !== undefined) source.name = input.name
    if (input.aliases !== undefined) source.aliases = cleanAliases(input.aliases)
    source.updatedBy = input.actorId
    await source.save({ session })
    requireUnambiguous(await MaterialSource.find().session(session).lean())
    await recordAudit({
      actorId: input.actorId,
      action: 'material_source.update',
      objectType: 'material_source',
      objectId: source._id,
      before,
      after: sourceAudit(source.toObject()),
      session,
    })
    return source.toObject()
  })
}

export async function deleteSource(input: { actorId: ActorId; id: string }): Promise<void> {
  await inTransaction(async (session) => {
    const source = await loadOrFail(MaterialSource, input.id, session)
    if (await Planting.exists({ sourceId: source._id }).session(session)) {
      throw inUse('This source')
    }
    markDeleted(source, input.actorId)
    await source.save({ session })
    await recordAudit({
      actorId: input.actorId,
      action: 'material_source.delete',
      objectType: 'material_source',
      objectId: source._id,
      before: sourceAudit(source.toObject()),
      session,
    })
  })
}
