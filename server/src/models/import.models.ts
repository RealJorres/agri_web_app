import { model, Schema } from 'mongoose'

import { baseFields, baseOptions, softDelete, type BaseDoc } from './base.js'

export const IMPORT_KINDS = ['template', 'legacy_cacao_2023', 'legacy_workbook'] as const
export type ImportKind = (typeof IMPORT_KINDS)[number]

export const IMPORT_STATUSES = [
  'uploaded',
  'validating',
  'ready',
  'committing',
  'committed',
  'failed',
] as const
export type ImportStatus = (typeof IMPORT_STATUSES)[number]

export interface ImportJobDoc extends BaseDoc {
  uploadedById: string
  kind: ImportKind
  status: ImportStatus
  filePath: string
  originalName: string
  fileSha256: string
  fileSize: number
  commodityId: string | null
  /** Template imports load into this open round. */
  surveyRoundId: string | null
  /** Workbook imports create or reuse the round with this name. */
  roundName: string | null
  asOfDate: Date | null
  /** Preview and commit results. Holds raw cell values, so it counts as personal data. */
  summary: Record<string, unknown>
  errorReportPath: string
  errorMessage: string
  committedAt: Date | null
  committedById: string | null
  filesPurgedAt: Date | null
}

const importJobSchema = new Schema<ImportJobDoc>(
  {
    ...baseFields,
    uploadedById: { type: String, required: true },
    kind: { type: String, required: true, enum: IMPORT_KINDS },
    status: { type: String, default: 'uploaded', enum: IMPORT_STATUSES },
    filePath: { type: String, default: '' },
    originalName: { type: String, required: true, maxlength: 255 },
    fileSha256: { type: String, required: true },
    fileSize: { type: Number, default: 0 },
    commodityId: { type: String, default: null },
    surveyRoundId: { type: String, default: null },
    roundName: { type: String, default: null },
    asOfDate: { type: Date, default: null },
    summary: { type: Schema.Types.Mixed, default: () => ({}) },
    errorReportPath: { type: String, default: '' },
    errorMessage: { type: String, default: '' },
    committedAt: { type: Date, default: null },
    committedById: { type: String, default: null },
    filesPurgedAt: { type: Date, default: null },
  },
  { ...baseOptions, collection: 'import_jobs', minimize: false },
)
importJobSchema.plugin(softDelete)
importJobSchema.index({ uploadedById: 1, createdAt: -1 })
importJobSchema.index({ fileSha256: 1 })
importJobSchema.index({ status: 1, updatedAt: 1 })

export const ImportJob = model<ImportJobDoc>('ImportJob', importJobSchema)

/** What one source row created. Makes importing the same file again a no-op (brief §10.A.8). */
export interface ImportRowLinkDoc {
  _id: string
  fileSha256: string
  sheet: string
  row: number
  jobId: string
  farmerId: string | null
  farmId: string | null
  cropStandId: string | null
  recordId: string | null
}

const importRowLinkSchema = new Schema<ImportRowLinkDoc>(
  {
    _id: baseFields._id,
    fileSha256: { type: String, required: true },
    sheet: { type: String, required: true },
    row: { type: Number, required: true },
    jobId: { type: String, required: true },
    farmerId: { type: String, default: null },
    farmId: { type: String, default: null },
    cropStandId: { type: String, default: null },
    recordId: { type: String, default: null },
  },
  { collection: 'import_row_links', versionKey: false },
)
importRowLinkSchema.index({ fileSha256: 1, sheet: 1, row: 1 }, { unique: true })

export const ImportRowLink = model<ImportRowLinkDoc>('ImportRowLink', importRowLinkSchema)
