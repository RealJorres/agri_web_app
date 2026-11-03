/**
 * Survey rounds and the inventory workflow (brief §8). The only code that changes a record's status.
 * Every transition is scope-checked and audited. Documents are loaded inside the transaction, so a
 * write conflict simply retries against fresh data.
 */
import type { ClientSession, HydratedDocument } from 'mongoose'

import { parseDateOnly } from '../lib/dates.js'
import { decimalString, toDecimal128 } from '../lib/decimal.js'
import { DomainError, notFound } from '../lib/errors.js'
import { isDuplicateKey } from '../lib/mongoErrors.js'
import { Cap } from '../lib/roles.js'
import {
  COPIED_SCOPE_PATHS,
  requireReach,
  scopeFilter,
  within,
  type Actor,
} from '../lib/scoping.js'
import { inTransaction } from '../lib/transaction.js'
import { lockForWrite, markDeleted } from '../models/base.js'
import {
  Commodity,
  GrowthStage,
  type CommodityDoc,
  type GrowthStageDoc,
} from '../models/catalog.models.js'
import { CropStand, Farm, type CropStandDoc, type FarmDoc } from '../models/farm.models.js'
import { Farmer, type FarmerDoc } from '../models/registry.models.js'
import {
  InventoryRecord,
  type InventoryRecordDoc,
  type RecordStatus,
  type StageCount,
  SurveyRound,
  type SurveyRoundDoc,
  WorkflowComment,
} from '../models/survey.models.js'
import { changes, recordAudit, recordAuditMany } from './audit.service.js'
import { evaluate } from './surveyRules.js'
import {
  canEdit,
  reaches,
  RETURN_BY_STATUS,
  roundAcceptsChanges,
  TRANSITIONS,
  type TransitionName,
} from './surveyWorkflow.js'

const OBJECT_TYPE = 'inventory_record'

export interface CountInput {
  growthStageId: string
  count?: number | null | undefined
  /** An exact decimal, as text. */
  areaHa?: string | null | undefined
}

// --- Rounds

export async function openRound({
  actor,
  commodityId,
  name,
  asOfDate,
  deadline = null,
  isHistorical = false,
}: {
  actor: Actor
  commodityId: string
  name: string
  asOfDate: string
  deadline?: string | null | undefined
  isHistorical?: boolean
}): Promise<SurveyRoundDoc> {
  return inTransaction(async (session) => {
    const commodity = await Commodity.findOne({ _id: commodityId })
      .session(session)
      .lean<CommodityDoc>()
    if (!commodity) {
      throw new DomainError('validation_error', 'Some fields are invalid.', {
        commodity: ['This does not exist.'],
      })
    }
    requireReach(actor.scope, Cap.MANAGE_ROUNDS, { programId: commodity.programId }, 'commodity')
    const round: HydratedDocument<SurveyRoundDoc> = new SurveyRound({
      commodityId,
      programId: commodity.programId,
      name: name.trim(),
      asOfDate: parseDateOnly(asOfDate),
      deadline: deadline ? parseDateOnly(deadline) : null,
      isHistorical,
      createdBy: actor.id,
      updatedBy: actor.id,
    })
    try {
      await round.save({ session })
    } catch (error) {
      if (isDuplicateKey(error, 'name')) {
        throw new DomainError(
          'duplicate_round',
          'A round with this name already exists for the commodity.',
          { name: ['Already used.'] },
          409,
        )
      }
      throw error
    }
    await recordAudit({
      actorId: actor.id,
      action: 'round.open',
      objectType: 'survey_round',
      objectId: round._id,
      after: { name: round.name, commodity: commodity.code, as_of: asOfDate },
      session,
    })
    return round.toObject()
  })
}

/**
 * Closes the round and locks its approved records. Returns how many were locked. Refuses while
 * records await review, so nothing is silently left half-way.
 */
export async function closeRound({
  actor,
  roundId,
}: {
  actor: Actor
  roundId: string
}): Promise<number> {
  return inTransaction(async (session) => {
    const round = await SurveyRound.findOne({ _id: roundId }).session(session)
    if (!round) throw notFound()
    requireReach(actor.scope, Cap.MANAGE_ROUNDS, { programId: round.programId }, 'survey_round')
    if (round.status === 'closed') {
      throw new DomainError('round_closed', 'This round is already closed.', {}, 409)
    }
    // This writes the round, which conflicts with any record being added or submitted right now.
    round.status = 'closed'
    round.closedAt = new Date()
    round.closedById = actor.id
    round.updatedBy = actor.id
    await round.save({ session })
    const pending = await InventoryRecord.countDocuments({
      surveyRoundId: roundId,
      status: { $in: ['submitted', 'validated'] },
    }).session(session)
    if (pending > 0) {
      throw new DomainError(
        'pending_records',
        `${String(pending)} records are still awaiting validation or approval.`,
        { records: [`${String(pending)} pending`] },
        409,
      )
    }
    const approved = await InventoryRecord.find({ surveyRoundId: roundId, status: 'approved' })
      .session(session)
      .select('_id')
      .lean()
    const ids = approved.map((row) => row._id)
    await InventoryRecord.updateMany(
      { _id: { $in: ids } },
      { status: 'locked', updatedBy: actor.id },
      { session },
    )
    await recordAuditMany(
      ids.map((id) => ({
        actorId: actor.id,
        action: 'inventory.lock',
        objectType: OBJECT_TYPE,
        objectId: id,
        before: { status: 'approved' },
        after: { status: 'locked' },
      })),
      session,
    )
    await recordAudit({
      actorId: actor.id,
      action: 'round.close',
      objectType: 'survey_round',
      objectId: round._id,
      after: { locked: ids.length },
      session,
    })
    return ids.length
  })
}

// --- Records

async function stagesOf(
  commodityId: string,
  session: ClientSession,
): Promise<Map<string, GrowthStageDoc>> {
  // Soft-deleted stages stay readable, because old counts still point at them.
  const stages = await GrowthStage.find({ commodityId, isDeleted: { $in: [true, false] } })
    .session(session)
    .lean<GrowthStageDoc[]>()
  return new Map(stages.map((stage) => [stage._id, stage]))
}

function recordSnapshot(
  record: Pick<InventoryRecordDoc, 'stageCounts' | 'remarks'>,
  stages: Map<string, GrowthStageDoc>,
): Record<string, unknown> {
  const rows = record.stageCounts
    .map((row) => ({ row, stage: stages.get(row.growthStageId) }))
    .sort((a, b) => (a.stage?.sortOrder ?? 0) - (b.stage?.sortOrder ?? 0))
  const counts = Object.fromEntries(
    rows.map(({ row, stage }) => [
      stage?.code ?? row.growthStageId,
      row.areaHa === null ? row.count : decimalString(row.areaHa, 4),
    ]),
  )
  return { counts, remarks: record.remarks }
}

/** Checks the full set of counts from a form, and returns what to store. */
async function checkedCounts(
  inputs: readonly CountInput[],
  commodityId: string,
  session: ClientSession,
): Promise<StageCount[]> {
  const ids = [...new Set(inputs.map((input) => input.growthStageId))]
  const stages = await GrowthStage.find({ _id: { $in: ids } })
    .session(session)
    .lean<GrowthStageDoc[]>()
  const stageById = new Map(stages.map((stage) => [stage._id, stage]))
  const seen = new Set<string>()
  return inputs.map(({ growthStageId, count = null, areaHa = null }) => {
    const stage = stageById.get(growthStageId)
    if (!stage) {
      throw new DomainError('validation_error', 'Some fields are invalid.', {
        counts: ['A growth stage does not exist.'],
      })
    }
    if (stage.commodityId !== commodityId) {
      throw new DomainError('stage_mismatch', 'A stage does not belong to this crop.', {
        counts: [`${stage.code} is not a stage of this commodity.`],
      })
    }
    if (seen.has(growthStageId)) {
      throw new DomainError('duplicate_stage', 'Each stage can appear once.', {
        counts: ['Duplicate stage.'],
      })
    }
    seen.add(growthStageId)
    if ((count !== null && count < 0) || (areaHa !== null && Number(areaHa) < 0)) {
      throw new DomainError('negative_count', 'Counts cannot be negative.', {
        [`counts.${stage.code}`]: ['Must be 0 or more.'],
      })
    }
    return { growthStageId, count, areaHa: areaHa === null ? null : toDecimal128(areaHa) }
  })
}

export async function createRecord({
  actor,
  roundId,
  standId,
  counts = [],
  remarks = '',
}: {
  actor: Actor
  roundId: string
  standId: string
  counts?: readonly CountInput[] | undefined
  remarks?: string | undefined
}): Promise<InventoryRecordDoc> {
  return inTransaction(async (session) => {
    const visible = scopeFilter(actor.scope, Cap.VIEW_RECORDS, COPIED_SCOPE_PATHS)
    const stand = await CropStand.findOne(within(visible, { _id: standId }))
      .session(session)
      .lean<CropStandDoc>()
    if (!stand) {
      throw new DomainError(
        'not_found',
        'Crop stand not found.',
        { crop_stand: ['Not found.'] },
        404,
      )
    }
    requireReach(
      actor.scope,
      Cap.EDIT_RECORDS,
      {
        barangayId: stand.barangayId,
        municipalityId: stand.municipalityId,
        programId: stand.programId,
      },
      'crop_stand',
    )
    if (!(await lockForWrite(SurveyRound, roundId, session))) {
      throw new DomainError('validation_error', 'Some fields are invalid.', {
        survey_round: ['This does not exist.'],
      })
    }
    const round = (await SurveyRound.findOne({ _id: roundId })
      .session(session)
      .lean<SurveyRoundDoc>()) as SurveyRoundDoc
    if (round.status !== 'open') {
      throw new DomainError('round_closed', 'This round is closed.', {}, 409)
    }
    if (stand.commodityId !== round.commodityId) {
      const commodity = await Commodity.findOne({ _id: round.commodityId })
        .session(session)
        .lean<CommodityDoc>()
      throw new DomainError(
        'commodity_mismatch',
        `This round is for ${commodity?.name ?? 'another crop'}.`,
        { crop_stand: ['Different commodity from the round.'] },
      )
    }
    if (!(await lockForWrite(CropStand, standId, session))) throw notFound()
    const record: HydratedDocument<InventoryRecordDoc> = new InventoryRecord({
      surveyRoundId: roundId,
      cropStandId: standId,
      barangayId: stand.barangayId,
      municipalityId: stand.municipalityId,
      programId: stand.programId,
      remarks: remarks.trim(),
      stageCounts: await checkedCounts(counts, stand.commodityId, session),
      encodedById: actor.id,
      createdBy: actor.id,
      updatedBy: actor.id,
    })
    try {
      await record.save({ session })
    } catch (error) {
      if (isDuplicateKey(error, 'cropStandId')) {
        throw new DomainError(
          'duplicate_record',
          'This crop stand already has a record in this round.',
          { crop_stand: ['Already recorded in this round.'] },
          409,
        )
      }
      throw error
    }
    await recordAudit({
      actorId: actor.id,
      action: 'inventory.create',
      objectType: OBJECT_TYPE,
      objectId: record._id,
      after: recordSnapshot(record, await stagesOf(stand.commodityId, session)),
      session,
    })
    return record.toObject()
  })
}

interface LoadedRecord {
  record: HydratedDocument<InventoryRecordDoc>
  round: SurveyRoundDoc
}

async function loadRecord(actor: Actor, id: string, session: ClientSession): Promise<LoadedRecord> {
  const visible = scopeFilter(actor.scope, Cap.VIEW_RECORDS, COPIED_SCOPE_PATHS)
  const record = await InventoryRecord.findOne(within(visible, { _id: id })).session(session)
  if (!record) throw notFound()
  const round = await SurveyRound.findOne({ _id: record.surveyRoundId })
    .session(session)
    .lean<SurveyRoundDoc>()
  if (!round) throw notFound()
  return { record, round }
}

export async function updateRecord({
  actor,
  recordId,
  counts,
  remarks,
}: {
  actor: Actor
  recordId: string
  counts?: readonly CountInput[] | undefined
  remarks?: string | undefined
}): Promise<InventoryRecordDoc> {
  return inTransaction(async (session) => {
    const { record, round } = await loadRecord(actor, recordId, session)
    if (!canEdit(actor.scope, record, round.status)) {
      throw new DomainError(
        'not_editable',
        `A ${record.status} record cannot be edited by you.`,
        {},
        reaches(actor.scope, Cap.EDIT_RECORDS, record) ? 409 : 403,
      )
    }
    const stages = await stagesOf(round.commodityId, session)
    const before = recordSnapshot(record, stages)
    if (counts !== undefined) {
      record.stageCounts = await checkedCounts(counts, round.commodityId, session)
    }
    if (remarks !== undefined) record.remarks = remarks.trim()
    record.updatedBy = actor.id
    await record.save({ session })
    const diff = changes(before, recordSnapshot(record, stages))
    if (Object.keys(diff.after).length > 0) {
      await recordAudit({
        actorId: actor.id,
        action: 'inventory.update',
        objectType: OBJECT_TYPE,
        objectId: record._id,
        before: diff.before,
        after: diff.after,
        session,
      })
    }
    return record.toObject()
  })
}

export async function deleteRecord({
  actor,
  recordId,
}: {
  actor: Actor
  recordId: string
}): Promise<void> {
  await inTransaction(async (session) => {
    const { record, round } = await loadRecord(actor, recordId, session)
    if (record.status !== 'draft' || !canEdit(actor.scope, record, round.status)) {
      throw new DomainError('not_editable', 'Only your draft records can be deleted.', {}, 409)
    }
    markDeleted(record, actor.id)
    await record.save({ session })
    await recordAudit({
      actorId: actor.id,
      action: 'inventory.delete',
      objectType: OBJECT_TYPE,
      objectId: record._id,
      before: recordSnapshot(record, await stagesOf(round.commodityId, session)),
      session,
    })
  })
}

async function applyTransition(
  { actor, record, round }: LoadedRecord & { actor: Actor },
  name: TransitionName,
  rawComment: string,
  session: ClientSession,
): Promise<InventoryRecordDoc> {
  const transition = TRANSITIONS[name]
  const verb = name.split('_')[0] ?? name
  if (!reaches(actor.scope, transition.capability, record)) {
    throw new DomainError('forbidden', 'You are not allowed to do this for this record.', {}, 403)
  }
  if (!transition.sources.includes(record.status)) {
    throw new DomainError(
      'invalid_transition',
      `Cannot ${verb} a ${record.status} record.`,
      {},
      409,
    )
  }
  const comment = rawComment.trim()
  if (transition.commentRequired && !comment) {
    throw new DomainError('comment_required', 'Please explain why in a comment.', {
      comment: ['Required.'],
    })
  }

  const before = { status: record.status, version: record.version }
  const now = new Date()
  record.status = transition.target
  if (name === 'submit') {
    record.submittedAt = now
  } else if (name === 'validate') {
    record.validatedById = actor.id
    record.validatedAt = now
  } else if (name === 'approve') {
    record.approvedById = actor.id
    record.approvedAt = now
    // Corrections approved after the round has closed are locked at once.
    if (round.status === 'closed') record.status = 'locked'
  } else if (name === 'reopen') {
    record.version += 1
  }
  if (transition.target === 'draft') {
    // Returned or reopened: the review stamps are cleared, and the audit log keeps the history.
    record.submittedAt = null
    record.validatedAt = null
    record.approvedAt = null
    record.validatedById = null
    record.approvedById = null
  }
  record.updatedBy = actor.id
  await record.save({ session })
  if (comment) {
    const number =
      (await WorkflowComment.countDocuments({ inventoryRecordId: record._id }).session(session)) + 1
    await WorkflowComment.create(
      [{ inventoryRecordId: record._id, number, authorId: actor.id, action: verb, body: comment }],
      { session },
    )
  }
  await recordAudit({
    actorId: actor.id,
    action: `inventory.${verb}`,
    objectType: OBJECT_TYPE,
    objectId: record._id,
    before,
    after: { status: record.status, version: record.version, comment: Boolean(comment) },
    session,
  })
  return record.toObject()
}

export interface TransitionInput {
  actor: Actor
  recordId: string
  comment?: string | undefined
}

async function transitionNamed(name: TransitionName, input: TransitionInput) {
  return inTransaction(async (session) => {
    const loaded = await loadRecord(input.actor, input.recordId, session)
    return applyTransition({ actor: input.actor, ...loaded }, name, input.comment ?? '', session)
  })
}

/** Runs the validation rules: errors block, and warnings are stored in the record's flags. */
export async function submit({ actor, recordId, comment = '' }: TransitionInput) {
  return inTransaction(async (session) => {
    const loaded = await loadRecord(actor, recordId, session)
    const { record, round } = loaded
    if (!roundAcceptsChanges(record, round.status)) {
      throw new DomainError('round_closed', 'This round is closed.', {}, 409)
    }
    // Closing the round conflicts with this, so a record cannot slip in as the round closes.
    await lockForWrite(SurveyRound, round._id, session)
    if (
      TRANSITIONS.submit.sources.includes(record.status) &&
      reaches(actor.scope, Cap.SUBMIT, record)
    ) {
      const stand = await CropStand.findOne({ _id: record.cropStandId })
        .session(session)
        .lean<CropStandDoc>()
      const commodity = await Commodity.findOne({ _id: round.commodityId })
        .session(session)
        .lean<CommodityDoc>()
      if (!stand || !commodity) throw notFound()
      const farm = await Farm.findOne({ _id: stand.farmId }).session(session).lean<FarmDoc>()
      const farmer = farm
        ? await Farmer.findOne({ _id: farm.farmerId }).session(session).lean<FarmerDoc>()
        : null
      const issues = await evaluate(record, commodity, farmer, session)
      const errors = issues.filter((issue) => issue.level === 'error')
      if (errors.length > 0) {
        const fields: Record<string, string[]> = {}
        for (const issue of errors) (fields[issue.field] ??= []).push(issue.message)
        throw new DomainError(
          'validation_failed',
          'Please fix the errors before submitting.',
          fields,
        )
      }
      record.flags = {
        ...record.flags,
        warnings: issues.filter((issue) => issue.level === 'warning'),
        checked_at: new Date().toISOString(),
      }
      record.markModified('flags')
    }
    return applyTransition({ actor, ...loaded }, 'submit', comment, session)
  })
}

export function validate(input: TransitionInput) {
  return transitionNamed('validate', input)
}

export function approve(input: TransitionInput) {
  return transitionNamed('approve', input)
}

export function reopen(input: TransitionInput) {
  return transitionNamed('reopen', input)
}

export async function returnRecord({ actor, recordId, comment = '' }: TransitionInput) {
  return inTransaction(async (session) => {
    const loaded = await loadRecord(actor, recordId, session)
    const status: RecordStatus = loaded.record.status
    const name = RETURN_BY_STATUS[status]
    if (name === undefined) {
      throw new DomainError('invalid_transition', `Cannot return a ${status} record.`, {}, 409)
    }
    return applyTransition({ actor, ...loaded }, name, comment, session)
  })
}
