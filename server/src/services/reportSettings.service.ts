/**
 * The letterhead, logo and signature blocks on official reports. These are part of a report's
 * content, so changing them marks any existing sign-off as superseded until it is signed again.
 */
import PDFDocument from 'pdfkit'

import { DomainError, notFound } from '../lib/errors.js'
import { removePrivateFile, savePrivateFile } from '../lib/privateFiles.js'
import { inTransaction } from '../lib/transaction.js'
import { markDeleted } from '../models/base.js'
import {
  ReportSettings,
  Signatory,
  type ReportKind,
  type ReportSettingsDoc,
  type SignatoryDoc,
} from '../models/report.models.js'
import { recordAudit } from './audit.service.js'

export const MAX_LOGO_BYTES = 2 * 1024 * 1024

function rejectLogo(message: string): DomainError {
  return new DomainError('invalid_logo', message, { file: [message] })
}

function logoSuffix(content: Buffer): '.png' | '.jpg' {
  if (content.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return '.png'
  if (content.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return '.jpg'
  throw rejectLogo('Upload a PNG or JPEG image.')
}

/** Tries the image in a throwaway PDF, because that is what reports will do with it. */
function requireDrawable(content: Buffer): void {
  try {
    new PDFDocument({ autoFirstPage: true }).image(content, 0, 0, { height: 56 })
  } catch {
    throw rejectLogo('This image is damaged or in a form reports cannot use.')
  }
}

async function currentSettings(session: Parameters<typeof ReportSettings.findById>[2]) {
  return ReportSettings.findById('current', null, session)
}

export async function updateReportSettings(input: {
  actorId: string
  letterhead?: string | undefined
  programLine?: string | undefined
}): Promise<void> {
  await inTransaction(async (session) => {
    const settings =
      (await currentSettings({ session })) ?? new ReportSettings({ _id: 'current', logoPath: '' })
    const before = { letterhead: settings.letterhead, programLine: settings.programLine }
    if (input.letterhead !== undefined) settings.letterhead = input.letterhead
    if (input.programLine !== undefined) settings.programLine = input.programLine
    await settings.save({ session })
    await recordAudit({
      actorId: input.actorId,
      action: 'report_settings.update',
      objectType: 'report_settings',
      objectId: settings._id,
      before,
      after: { letterhead: settings.letterhead, programLine: settings.programLine },
      session,
    })
  })
}

async function replaceLogo(actorId: string, logoPath: string, action: string): Promise<string> {
  return inTransaction(async (session) => {
    const settings: ReportSettingsDoc & { save: (o: object) => Promise<unknown> } =
      (await currentSettings({ session })) ?? new ReportSettings({ _id: 'current' })
    const previous = settings.logoPath
    settings.logoPath = logoPath
    await settings.save({ session })
    await recordAudit({
      actorId,
      action,
      objectType: 'report_settings',
      objectId: 'current',
      session,
    })
    return previous
  })
}

export async function setReportLogo(input: { actorId: string; content: Buffer }): Promise<void> {
  if (input.content.length > MAX_LOGO_BYTES) throw rejectLogo('The image is larger than 2 MB.')
  const suffix = logoSuffix(input.content)
  requireDrawable(input.content)
  const logoPath = await savePrivateFile('report-logos', suffix, input.content)
  let previous: string
  try {
    previous = await replaceLogo(input.actorId, logoPath, 'report_settings.set_logo')
  } catch (error) {
    await removePrivateFile(logoPath)
    throw error
  }
  if (previous) await removePrivateFile(previous)
}

export async function removeReportLogo(input: { actorId: string }): Promise<void> {
  const previous = await replaceLogo(input.actorId, '', 'report_settings.remove_logo')
  if (previous) await removePrivateFile(previous)
}

function signatoryAudit(row: SignatoryDoc) {
  return { reportKind: row.reportKind, order: row.order, caption: row.caption, title: row.title }
}

export async function createSignatory(input: {
  actorId: string
  reportKind: ReportKind
  order: number
  caption: string
  name: string
  title?: string | undefined
}): Promise<SignatoryDoc> {
  return inTransaction(async (session) => {
    const row = new Signatory({
      reportKind: input.reportKind,
      order: input.order,
      caption: input.caption,
      name: input.name,
      title: input.title ?? '',
      createdBy: input.actorId,
      updatedBy: input.actorId,
    })
    await row.save({ session })
    await recordAudit({
      actorId: input.actorId,
      action: 'signatory.create',
      objectType: 'signatory',
      objectId: row._id,
      after: signatoryAudit(row.toObject()),
      session,
    })
    return row.toObject()
  })
}

export async function updateSignatory(input: {
  actorId: string
  id: string
  order?: number | undefined
  caption?: string | undefined
  name?: string | undefined
  title?: string | undefined
}): Promise<SignatoryDoc> {
  return inTransaction(async (session) => {
    const row = await Signatory.findOne({ _id: input.id }).session(session)
    if (!row) throw notFound()
    const before = signatoryAudit(row.toObject())
    if (input.order !== undefined) row.order = input.order
    if (input.caption !== undefined) row.caption = input.caption
    if (input.name !== undefined) row.name = input.name
    if (input.title !== undefined) row.title = input.title
    row.updatedBy = input.actorId
    await row.save({ session })
    await recordAudit({
      actorId: input.actorId,
      action: 'signatory.update',
      objectType: 'signatory',
      objectId: row._id,
      before,
      after: signatoryAudit(row.toObject()),
      session,
    })
    return row.toObject()
  })
}

export async function deleteSignatory(input: { actorId: string; id: string }): Promise<void> {
  await inTransaction(async (session) => {
    const row = await Signatory.findOne({ _id: input.id }).session(session)
    if (!row) throw notFound()
    markDeleted(row, input.actorId)
    await row.save({ session })
    await recordAudit({
      actorId: input.actorId,
      action: 'signatory.delete',
      objectType: 'signatory',
      objectId: row._id,
      before: signatoryAudit(row.toObject()),
      session,
    })
  })
}
