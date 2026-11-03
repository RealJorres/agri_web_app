import { model, Schema, type Types } from 'mongoose'

import {
  baseFields,
  baseOptions,
  softDelete,
  uniqueAmongAlive,
  writeGuardField,
  type BaseDoc,
} from './base.js'
import type { CopiedScope } from './farm.models.js'

export const ROUND_STATUSES = ['open', 'closed'] as const
export type RoundStatus = (typeof ROUND_STATUSES)[number]

/** One inventory campaign for one commodity. */
export interface SurveyRoundDoc extends BaseDoc {
  commodityId: string
  /** Copied from the commodity, for scoping (ADR-0019). */
  programId: string
  name: string
  asOfDate: Date
  deadline: Date | null
  status: RoundStatus
  /** True for rounds reconstructed from legacy workbooks. */
  isHistorical: boolean
  closedAt: Date | null
  closedById: string | null
  writeGuard: number
}

const surveyRoundSchema = new Schema<SurveyRoundDoc>(
  {
    ...baseFields,
    ...writeGuardField,
    commodityId: { type: String, required: true },
    programId: { type: String, required: true },
    name: { type: String, required: true, maxlength: 150 },
    asOfDate: { type: Date, required: true },
    deadline: { type: Date, default: null },
    status: { type: String, default: 'open', enum: ROUND_STATUSES },
    isHistorical: { type: Boolean, default: false },
    closedAt: { type: Date, default: null },
    closedById: { type: String, default: null },
  },
  { ...baseOptions, collection: 'survey_rounds' },
)
surveyRoundSchema.plugin(softDelete)
surveyRoundSchema.index({ commodityId: 1, name: 1 }, uniqueAmongAlive)

export const SurveyRound = model<SurveyRoundDoc>('SurveyRound', surveyRoundSchema)

export const RECORD_STATUSES = ['draft', 'submitted', 'validated', 'approved', 'locked'] as const
export type RecordStatus = (typeof RECORD_STATUSES)[number]

/** Statuses whose numbers are official: summaries use these records only (brief rule). */
export const OFFICIAL_STATUSES: readonly RecordStatus[] = ['approved', 'locked']

export interface StageCount {
  growthStageId: string
  count: number | null
  /** Only for area commodities. Tree areas are derived, never stored (ADR-0004). */
  areaHa: Types.Decimal128 | null
}

const stageCountSchema = new Schema<StageCount>(
  {
    growthStageId: { type: String, required: true },
    count: { type: Number, default: null, min: 0 },
    areaHa: { type: Schema.Types.Decimal128, default: null },
  },
  { _id: false },
)

/** Stage counts for one crop stand in one round. Status changes only through survey.service. */
export interface InventoryRecordDoc extends BaseDoc, CopiedScope {
  surveyRoundId: string
  cropStandId: string
  status: RecordStatus
  version: number
  encodedById: string | null
  submittedAt: Date | null
  validatedById: string | null
  validatedAt: Date | null
  approvedById: string | null
  approvedAt: Date | null
  remarks: string
  /** Warnings from the validation rules, and notes such as the import source. */
  flags: Record<string, unknown>
  stageCounts: StageCount[]
}

const inventoryRecordSchema = new Schema<InventoryRecordDoc>(
  {
    ...baseFields,
    barangayId: { type: String, required: true },
    municipalityId: { type: String, required: true },
    programId: { type: String, required: true },
    surveyRoundId: { type: String, required: true },
    cropStandId: { type: String, required: true },
    status: { type: String, default: 'draft', enum: RECORD_STATUSES },
    version: { type: Number, default: 1, min: 1 },
    encodedById: { type: String, default: null },
    submittedAt: { type: Date, default: null },
    validatedById: { type: String, default: null },
    validatedAt: { type: Date, default: null },
    approvedById: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    remarks: { type: String, default: '' },
    flags: { type: Schema.Types.Mixed, default: () => ({}) },
    stageCounts: { type: [stageCountSchema], default: [] },
  },
  { ...baseOptions, collection: 'inventory_records', minimize: false },
)
inventoryRecordSchema.plugin(softDelete)
inventoryRecordSchema.index({ surveyRoundId: 1, cropStandId: 1 }, uniqueAmongAlive)
inventoryRecordSchema.index({ surveyRoundId: 1, municipalityId: 1, status: 1 })
inventoryRecordSchema.index({ cropStandId: 1 })

export const InventoryRecord = model<InventoryRecordDoc>('InventoryRecord', inventoryRecordSchema)

/** A note left with a workflow action. Never edited or deleted. */
export interface WorkflowCommentDoc {
  _id: string
  inventoryRecordId: string
  /** 1, 2, 3... within the record. The API contract identifies comments by this number. */
  number: number
  authorId: string | null
  action: string
  body: string
  createdAt: Date
}

const workflowCommentSchema = new Schema<WorkflowCommentDoc>(
  {
    _id: baseFields._id,
    inventoryRecordId: { type: String, required: true },
    number: { type: Number, required: true },
    authorId: { type: String, default: null },
    action: { type: String, required: true, maxlength: 20 },
    body: { type: String, required: true },
  },
  {
    collection: 'workflow_comments',
    versionKey: false,
    timestamps: { createdAt: true, updatedAt: false },
  },
)
workflowCommentSchema.index({ inventoryRecordId: 1, number: 1 }, { unique: true })

export const WorkflowComment = model<WorkflowCommentDoc>('WorkflowComment', workflowCommentSchema)
