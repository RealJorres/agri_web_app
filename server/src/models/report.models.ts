import { model, Schema } from 'mongoose'

import { baseFields, baseOptions, softDelete, type BaseDoc } from './base.js'

export const REPORT_KINDS = ['summary', 'municipal_list'] as const
export type ReportKind = (typeof REPORT_KINDS)[number]

export const DEFAULT_LETTERHEAD = [
  'Republic of the Philippines',
  'Provincial Government of Marinduque',
  'PROVINCIAL AGRICULTURE OFFICE',
  'Capitol Compound, Santol, Boac, Marinduque',
].join('\n')
export const DEFAULT_PROGRAM_LINE = 'HIGH VALUE CROPS DEVELOPMENT PROGRAM (HVCDP)'

/** One row: the letterhead on every official report (ADR-0015). */
export interface ReportSettingsDoc {
  _id: string
  letterhead: string
  programLine: string
  /** Shown on PDFs. Kept here because a host's disk may not last (ADR-0023). */
  logo: Buffer | null
}

const reportSettingsSchema = new Schema<ReportSettingsDoc>(
  {
    _id: { type: String, default: 'current' },
    letterhead: { type: String, default: DEFAULT_LETTERHEAD },
    programLine: { type: String, default: DEFAULT_PROGRAM_LINE, maxlength: 200 },
    logo: { type: Buffer, default: null, select: false },
  },
  { collection: 'report_settings', versionKey: false, timestamps: true },
)

export const ReportSettings = model<ReportSettingsDoc>('ReportSettings', reportSettingsSchema)

/** A signature block on a report: for example "Prepared by:", a name and a title. */
export interface SignatoryDoc extends BaseDoc {
  reportKind: ReportKind
  order: number
  caption: string
  name: string
  title: string
}

const signatorySchema = new Schema<SignatoryDoc>(
  {
    ...baseFields,
    reportKind: { type: String, required: true, enum: REPORT_KINDS },
    order: { type: Number, default: 1, min: 0 },
    caption: { type: String, required: true, maxlength: 60 },
    name: { type: String, required: true, maxlength: 120 },
    title: { type: String, default: '', maxlength: 160 },
  },
  { ...baseOptions, collection: 'signatories' },
)
signatorySchema.plugin(softDelete)
signatorySchema.index({ reportKind: 1, order: 1 })

export const Signatory = model<SignatoryDoc>('Signatory', signatorySchema)

/** The provincial head's sign-off: who, when, and a hash of the report's content. */
export interface ReportSignoffDoc extends BaseDoc {
  surveyRoundId: string
  reportKind: ReportKind
  contentSha256: string
  signedById: string
  signedAt: Date
}

const reportSignoffSchema = new Schema<ReportSignoffDoc>(
  {
    ...baseFields,
    surveyRoundId: { type: String, required: true },
    reportKind: { type: String, required: true, enum: REPORT_KINDS },
    contentSha256: { type: String, required: true },
    signedById: { type: String, required: true },
    signedAt: { type: Date, required: true },
  },
  { ...baseOptions, collection: 'report_signoffs' },
)
reportSignoffSchema.plugin(softDelete)
reportSignoffSchema.index({ surveyRoundId: 1, reportKind: 1, signedAt: -1 })

export const ReportSignoff = model<ReportSignoffDoc>('ReportSignoff', reportSignoffSchema)
