/**
 * Import jobs: upload, preview (validate, plan, reconcile), then commit. Preview and commit both read
 * the stored file again, so what the user saw is what gets committed, and nothing personal is kept
 * outside the private file and the job's summary. See ADR-0020 for how each kind commits.
 */
import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'

import type { ClientSession } from 'mongoose'

import { parseDateOnly } from '../../lib/dates.js'
import { toDecimal128 } from '../../lib/decimal.js'
import { DomainError } from '../../lib/errors.js'
import { logger, safeErrorDetails } from '../../lib/logger.js'
import { hashPassword } from '../../lib/passwords.js'
import { readPrivateFile, removePrivateFile, savePrivateFile } from '../../lib/privateFiles.js'
import { Cap, Role } from '../../lib/roles.js'
import { canReach, Scope, type Actor } from '../../lib/scoping.js'
import { normalizeName } from '../../lib/text.js'
import { inTransaction } from '../../lib/transaction.js'
import { User } from '../../models/account.models.js'
import { lockForWrite } from '../../models/base.js'
import {
  Commodity,
  type CommodityDoc,
  GrowthStage,
  type GrowthStageDoc,
} from '../../models/catalog.models.js'
import { CropStand, Farm, Harvest, Planting } from '../../models/farm.models.js'
import {
  ImportJob,
  type ImportJobDoc,
  type ImportKind,
  ImportRowLink,
} from '../../models/import.models.js'
import { Barangay, Municipality } from '../../models/location.models.js'
import {
  Association,
  AssociationMember,
  Farmer,
  type FarmerDoc,
} from '../../models/registry.models.js'
import { InventoryRecord, SurveyRound, type SurveyRoundDoc } from '../../models/survey.models.js'
import { stageIndex } from '../../selectors/catalog.selectors.js'
import { stageTotals } from '../../selectors/survey.selectors.js'
import { recordAudit, recordAuditMany } from '../audit.service.js'
import { checkUpload, type UploadSuffix } from './uploads.js'
import { buildPlan, rowIdentity, type PlannedRow, type WorkbookPlan } from './workbookPlan.js'
import { readWorkbook } from './workbookReader.js'
import { commitTemplate, previewTemplate } from './template.js'

// The 2023 workbook's values, for the kind that names no commodity (the legacy adapter, ADR-0020).
const LEGACY_2023 = {
  commodityCode: 'CACAO',
  roundName: 'Cacao inventory - July 2023',
  asOfDate: '2023-07-31',
}

const SYSTEM_EMAIL = 'system@agri-dms.invalid'
const FILE_RETENTION_DAYS = 30
const DAY_MS = 86_400_000

const FULL_SCOPE = new Scope(null, [
  { role: Role.SYSTEM_ADMIN, municipalityId: null, programId: null, barangayIds: new Set() },
])

/** An inactive service account, recorded as the actor for command-line imports. It cannot sign in. */
export async function systemActor(): Promise<Actor> {
  const existing = await User.findOne({ email: SYSTEM_EMAIL }).lean()
  if (existing) return { id: existing._id, scope: FULL_SCOPE }
  const user = await User.create({
    email: SYSTEM_EMAIL,
    passwordHash: await hashPassword(randomBytes(32).toString('hex')),
    firstName: 'System',
    lastName: 'Import',
    isActive: false,
  })
  return { id: user._id, scope: FULL_SCOPE }
}

export interface UploadInput {
  actor: Actor
  name: string
  content: Buffer
  kind: ImportKind
  roundId?: string | null | undefined
  commodityId?: string | null | undefined
  roundName?: string | null | undefined
  asOfDate?: string | null | undefined
  enforceScope?: boolean
}

async function workbookTarget(input: UploadInput) {
  const legacy = input.kind === 'legacy_cacao_2023'
  const lookup = legacy ? { code: LEGACY_2023.commodityCode } : { _id: input.commodityId ?? '' }
  const commodity = await Commodity.findOne(lookup).lean<CommodityDoc>()
  if (!commodity) {
    if (legacy) {
      throw new DomainError('catalog_missing', 'Seed the catalog first (npm run seed).', {}, 409)
    }
    throw new DomainError('commodity_required', 'Choose the crop this workbook is for.', {
      commodity: ['Required.'],
    })
  }
  if (commodity.measureType !== 'trees') {
    throw new DomainError(
      'unsupported_measure',
      `${commodity.name} is measured by area, and this workbook layout holds tree counts.`,
      { commodity: ['Only tree crops can use this workbook layout.'] },
    )
  }
  const roundName = legacy ? LEGACY_2023.roundName : input.roundName?.trim()
  const asOfDate = legacy ? LEGACY_2023.asOfDate : input.asOfDate
  if (!roundName || !asOfDate) {
    throw new DomainError('round_details_required', 'Name the survey round and its as-of date.', {
      ...(roundName ? {} : { round_name: ['Required.'] }),
      ...(asOfDate ? {} : { as_of_date: ['Required.'] }),
    })
  }
  return { commodityId: commodity._id, roundName, asOfDate: parseDateOnly(asOfDate) }
}

async function templateTarget(input: UploadInput) {
  const round = input.roundId
    ? await SurveyRound.findOne({ _id: input.roundId }).lean<SurveyRoundDoc>()
    : null
  if (!round) {
    throw new DomainError('round_required', 'Choose the survey round to load into.', {
      survey_round: ['Required.'],
    })
  }
  if (round.status !== 'open') {
    throw new DomainError('round_closed', 'That round is closed.', { survey_round: ['Closed.'] })
  }
  return { commodityId: round.commodityId, surveyRoundId: round._id }
}

export async function createJob(input: UploadInput): Promise<ImportJobDoc> {
  const { actor, content, kind, enforceScope = true } = input
  if (enforceScope && !actor.scope.can(Cap.RUN_IMPORTS)) {
    throw new DomainError('forbidden', 'You are not allowed to run imports.', {}, 403)
  }
  const target = kind === 'template' ? await templateTarget(input) : await workbookTarget(input)
  const allowed: UploadSuffix[] = kind === 'template' ? ['.xlsx', '.csv'] : ['.xlsx']
  const name = basename(input.name.replaceAll('\\', '/')) || 'upload'
  const { sha256, suffix } = checkUpload(name, content, allowed)
  const filePath = await savePrivateFile('imports', suffix, content)
  try {
    return await inTransaction(async (session) => {
      const job = new ImportJob({
        uploadedById: actor.id ?? '',
        kind,
        filePath,
        originalName: name.slice(0, 255),
        fileSha256: sha256,
        fileSize: content.length,
        ...target,
        createdBy: actor.id,
        updatedBy: actor.id,
      })
      await job.save({ session })
      await recordAudit({
        actorId: actor.id,
        action: 'import.upload',
        objectType: 'import_job',
        objectId: job._id,
        after: { kind, size: content.length, sha256 },
        session,
      })
      return job.toObject()
    })
  } catch (error) {
    await removePrivateFile(filePath)
    throw error
  }
}

async function setStatus(
  id: string,
  status: ImportJobDoc['status'],
  fields: Partial<ImportJobDoc> = {},
  session?: ClientSession,
): Promise<void> {
  await ImportJob.updateOne({ _id: id }, { status, ...fields }, session ? { session } : {})
}

async function jobOrThrow(id: string): Promise<ImportJobDoc> {
  const job = await ImportJob.findOne({ _id: id }).lean<ImportJobDoc>()
  if (!job) throw new DomainError('not_found', 'Not found.', {}, 404)
  return job
}

async function commodityOf(job: ImportJobDoc): Promise<CommodityDoc> {
  const commodity = await Commodity.findOne({ _id: job.commodityId ?? '' }).lean<CommodityDoc>()
  if (!commodity) throw new DomainError('catalog_missing', 'The crop no longer exists.', {}, 409)
  return commodity
}

async function planFor(
  job: ImportJobDoc,
  commodity: CommodityDoc,
  overrides?: Record<string, string>,
): Promise<WorkbookPlan> {
  const [content, towns, stages] = await Promise.all([
    readPrivateFile(job.filePath),
    Municipality.find().lean(),
    stageIndex(commodity._id),
  ])
  const workbook = await readWorkbook(
    content,
    towns.map((town) => town.name),
    (label) => stages.resolve(label),
  )
  if (workbook.sheets.length === 0) {
    throw new DomainError('no_sheets', 'No municipal sheets were found in this workbook.')
  }
  return buildPlan(workbook, commodity, overrides)
}

function summaryOfPlan(plan: WorkbookPlan) {
  return {
    municipalities: [...new Set(plan.rows.map((row) => row.municipality))].sort(),
    counts: plan.counts,
    review: plan.review,
    decisions: plan.decisions,
    reconciliation: plan.reconciliation,
    sheet_issues: plan.sheetIssues,
    errors: [],
  }
}

/** Validates and plans the upload, and stores the preview in the job. Never writes records. */
export async function runPreview(jobId: string): Promise<ImportJobDoc> {
  const job = await jobOrThrow(jobId)
  await setStatus(jobId, 'validating', { errorMessage: '' })
  try {
    const commodity = await commodityOf(job)
    let summary: Record<string, unknown>
    let errorReportPath = ''
    if (job.kind === 'template') {
      const preview = await previewTemplate(job, commodity)
      summary = preview.summary
      if (preview.report) {
        errorReportPath = await savePrivateFile('import-errors', '.xlsx', preview.report)
      }
    } else {
      summary = summaryOfPlan(await planFor(job, commodity))
    }
    summary.already_imported = Boolean(await ImportRowLink.exists({ fileSha256: job.fileSha256 }))
    await setStatus(jobId, 'ready', { summary, errorReportPath })
  } catch (error) {
    if (error instanceof DomainError) {
      await setStatus(jobId, 'failed', { errorMessage: error.message })
    } else {
      // The error is logged without its message, because that could quote a cell.
      logger.error('import.preview_failed', { job: jobId, ...safeErrorDetails(error) })
      await setStatus(jobId, 'failed', { errorMessage: 'The file could not be read.' })
    }
  }
  return jobOrThrow(jobId)
}

/** Refuses a commit outside the user's assignment. Workbook rows are imported as approved. */
export async function checkCommitRights(job: ImportJobDoc, actor: Actor): Promise<void> {
  const needed = job.kind === 'template' ? [Cap.RUN_IMPORTS] : [Cap.RUN_IMPORTS, Cap.APPROVE]
  const commodity = await commodityOf(job)
  const names = (job.summary.municipalities ?? []) as string[]
  const towns = await Municipality.find({ name: { $in: names } }).lean()
  for (const town of towns) {
    for (const capability of needed) {
      const target = { municipalityId: town._id, programId: commodity.programId }
      if (!canReach(actor.scope, capability, target)) {
        throw new DomainError(
          'forbidden',
          'This file contains municipalities or a program outside your assignment.',
          {},
          403,
        )
      }
    }
  }
}

function notReady(status: string): DomainError {
  return new DomainError('not_ready', `This import is ${status}.`, {}, 409)
}

/** Refused while another commit runs. Moves the job on atomically, so only one can start. */
export async function commitJob({
  jobId,
  actor,
  associationOverrides,
  enforceScope = true,
}: {
  jobId: string
  actor: Actor
  associationOverrides?: Record<string, string> | undefined
  enforceScope?: boolean
}): Promise<ImportJobDoc> {
  const job = await jobOrThrow(jobId)
  if (job.status !== 'ready') throw notReady(job.status)
  if (enforceScope) await checkCommitRights(job, actor)
  const claimed = await ImportJob.findOneAndUpdate(
    { _id: jobId, status: 'ready' },
    { status: 'committing' },
  ).lean()
  if (!claimed) throw notReady('already being committed')
  try {
    const commodity = await commodityOf(job)
    if (job.kind === 'template') {
      const result = await commitTemplate(job, commodity, actor)
      await finishCommit(job, actor, result)
    } else {
      const plan = await planFor(job, commodity, associationOverrides)
      await inTransaction(async (session) => {
        const result = await commitWorkbook(job, commodity, plan, actor, session)
        await finishCommit(job, actor, result, session)
      })
    }
  } catch (error) {
    if (error instanceof DomainError) {
      await setStatus(jobId, 'failed', { errorMessage: error.message })
    } else {
      logger.error('import.commit_failed', { job: jobId, ...safeErrorDetails(error) })
      const saved = await ImportRowLink.countDocuments({ jobId })
      await setStatus(jobId, 'failed', {
        errorMessage:
          saved > 0
            ? `The import stopped after saving ${String(saved)} rows. Upload the same file again ` +
              'to continue: saved rows are skipped.'
            : 'The import failed; nothing was saved.',
      })
    }
    throw error
  }
  return jobOrThrow(jobId)
}

async function finishCommit(
  job: ImportJobDoc,
  actor: Actor,
  result: Record<string, unknown>,
  session?: ClientSession,
): Promise<void> {
  const write = async (active: ClientSession) => {
    await recordAudit({
      actorId: actor.id,
      action: 'import.commit',
      objectType: 'import_job',
      objectId: job._id,
      after: result,
      session: active,
    })
    await setStatus(
      job._id,
      'committed',
      {
        summary: { ...job.summary, commit: result },
        committedAt: new Date(),
        committedById: actor.id,
      },
      active,
    )
  }
  if (session) await write(session)
  else await inTransaction(write)
}

/** A restart ends any job in progress: without this, it would look busy forever. */
export async function failInterruptedJobs(): Promise<number> {
  const result = await ImportJob.updateMany(
    { status: { $in: ['validating', 'committing'] } },
    {
      status: 'failed',
      errorMessage:
        'The server restarted during this import. Upload the file again: saved rows are skipped.',
    },
  )
  return result.modifiedCount
}

/** Deletes stored files of finished jobs after the retention period (ADR-0009). */
export async function purgeOldFiles(now = new Date()): Promise<number> {
  const days = Number(process.env.IMPORT_FILE_RETENTION_DAYS ?? FILE_RETENTION_DAYS)
  const jobs = await ImportJob.find({
    status: { $in: ['committed', 'failed'] },
    updatedAt: { $lt: new Date(now.getTime() - days * DAY_MS) },
    filesPurgedAt: null,
  }).lean<ImportJobDoc[]>()
  for (const job of jobs) {
    if (job.filePath) await removePrivateFile(job.filePath)
    if (job.errorReportPath) await removePrivateFile(job.errorReportPath)
    await ImportJob.updateOne(
      { _id: job._id },
      { filePath: '', errorReportPath: '', filesPurgedAt: new Date() },
    )
  }
  return jobs.length
}

// --- Workbook commit: every document is built first, then written in bulk (ADR-0020).

class WorkbookBatch {
  readonly barangays = new Map<string, InstanceType<typeof Barangay>>()
  readonly associations = new Map<string, InstanceType<typeof Association>>()
  readonly farmers = new Map<string, InstanceType<typeof Farmer>>()
  readonly newBarangays: InstanceType<typeof Barangay>[] = []
  readonly newAssociations: InstanceType<typeof Association>[] = []
  readonly newFarmers: InstanceType<typeof Farmer>[] = []
  readonly members: InstanceType<typeof AssociationMember>[] = []
  readonly memberKeys = new Set<string>()
  readonly farms: InstanceType<typeof Farm>[] = []
  readonly stands: InstanceType<typeof CropStand>[] = []
  readonly plantings: InstanceType<typeof Planting>[] = []
  readonly records: InstanceType<typeof InventoryRecord>[] = []
  readonly harvests: InstanceType<typeof Harvest>[] = []
  readonly links: InstanceType<typeof ImportRowLink>[] = []
}

async function roundForWorkbook(
  job: ImportJobDoc,
  commodity: CommodityDoc,
  actor: Actor,
  session: ClientSession,
): Promise<SurveyRoundDoc> {
  const name = job.roundName ?? ''
  const existing = await SurveyRound.findOne({ commodityId: commodity._id, name })
    .session(session)
    .lean<SurveyRoundDoc>()
  if (existing) {
    await lockForWrite(SurveyRound, existing._id, session)
    return existing
  }
  const round = new SurveyRound({
    commodityId: commodity._id,
    programId: commodity.programId,
    name,
    asOfDate: job.asOfDate,
    isHistorical: true,
    createdBy: actor.id,
    updatedBy: actor.id,
  })
  await round.save({ session })
  await recordAudit({
    actorId: actor.id,
    action: 'round.open',
    objectType: 'survey_round',
    objectId: round._id,
    after: { historical: true },
    session,
  })
  return round.toObject()
}

/** One planting per year, and a source only when unambiguous (ADR-0013). */
function addPlantings(
  batch: WorkbookBatch,
  stand: InstanceType<typeof CropStand>,
  row: PlannedRow,
  actor: Actor,
): number {
  const years: (number | null)[] =
    row.years.length > 0
      ? row.years
      : row.varieties.length > 0 || row.sources.length > 0
        ? [null]
        : []
  const notes: string[] = []
  if (row.sources.length > 1) {
    notes.push(`Sources: ${row.sources.map((source) => source.name).join(', ')}`)
  }
  if (row.years.length > 1 && (row.varieties.length > 1 || row.sources.length > 1)) {
    notes.push(
      `Legacy cells - variety: '${row.rawVariety}', source: '${row.rawSource}', ` +
        `planted: '${row.rawDate}' (per-year breakdown unknown)`,
    )
  }
  const sourceId = row.sources.length === 1 ? (row.sources[0]?._id ?? null) : null
  for (const year of years) {
    batch.plantings.push(
      new Planting({
        cropStandId: stand._id,
        barangayId: stand.barangayId,
        municipalityId: stand.municipalityId,
        programId: stand.programId,
        yearPlanted: year,
        sourceId,
        notes: notes.join('; '),
        varietyIds: row.varieties.map((variety) => variety._id),
        createdBy: actor.id,
        updatedBy: actor.id,
      }),
    )
  }
  return years.length
}

async function commitWorkbook(
  job: ImportJobDoc,
  commodity: CommodityDoc,
  plan: WorkbookPlan,
  actor: Actor,
  session: ClientSession,
): Promise<Record<string, unknown>> {
  const round = await roundForWorkbook(job, commodity, actor, session)
  const linkRows = await ImportRowLink.find({ fileSha256: job.fileSha256 })
    .session(session)
    .select('sheet row')
    .lean()
  const linked = new Set(linkRows.map((link) => `${link.sheet}|${String(link.row)}`))
  const isLinked = (row: PlannedRow) => linked.has(`${row.sheet}|${String(row.row)}`)
  const [towns, stageRows, barangayRows, associationRows] = await Promise.all([
    Municipality.find().session(session).lean(),
    GrowthStage.find({ commodityId: commodity._id }).session(session).lean<GrowthStageDoc[]>(),
    Barangay.find().session(session),
    Association.find().session(session),
  ])
  const townByName = new Map(towns.map((town) => [town.name, town]))
  const stages = new Map(stageRows.map((stage) => [stage.code, stage]))
  const batch = new WorkbookBatch()
  for (const row of barangayRows) {
    batch.barangays.set(`${row.municipalityId}|${row.normalizedName}`, row)
  }
  for (const row of associationRows) {
    batch.associations.set(`${row.municipalityId}|${row.normalizedName}`, row)
  }
  const associationById = new Map(associationRows.map((row) => [row._id, row]))
  const tally: Record<string, number> = {}
  const bump = (key: string, by = 1) => {
    tally[key] = (tally[key] ?? 0) + by
  }
  const now = new Date()
  const stamp = { createdBy: actor.id, updatedBy: actor.id }

  const barangayFor = (townId: string, name: string) => {
    const key = `${townId}|${normalizeName(name)}`
    let found = batch.barangays.get(key)
    if (!found && name) {
      found = new Barangay({ municipalityId: townId, name, isVerified: false, ...stamp })
      batch.barangays.set(key, found)
      batch.newBarangays.push(found)
    }
    return found
  }

  // Every home barangay in the file exists before FARM LOCATION is matched, so the result does not
  // depend on row order.
  for (const row of plan.rows) {
    const town = townByName.get(row.municipality)
    if (town && row.homeBarangay && !isLinked(row)) barangayFor(town._id, row.homeBarangay)
  }

  for (const row of plan.rows) {
    if (isLinked(row)) {
      bump('rows_already_imported')
      continue
    }
    const town = townByName.get(row.municipality)
    const home = town && barangayFor(town._id, row.homeBarangay || row.farmBarangay)
    if (!town || !home) {
      bump('rows_skipped_no_barangay')
      continue
    }

    const identity = rowIdentity(row)
    let farmer = batch.farmers.get(identity)
    if (!farmer) {
      farmer = new Farmer({
        firstName: row.name.first,
        middleName: row.name.middle,
        lastName: row.name.last,
        suffix: row.name.suffix,
        fullNameRaw: row.fullNameRaw,
        contactNo: row.contact.slice(0, 40),
        homeBarangayId: home._id,
        municipalityId: town._id,
        status: row.incomplete ? 'needs_review' : 'active',
        ...stamp,
      })
      batch.farmers.set(identity, farmer)
      batch.newFarmers.push(farmer)
      bump('farmers')
    }
    for (const choice of row.associations) {
      const key = `${town._id}|${normalizeName(choice.canonical)}`
      let association = choice.existingId
        ? associationById.get(choice.existingId)
        : batch.associations.get(key)
      if (!association) {
        association = new Association({
          name: choice.canonical,
          municipalityId: town._id,
          ...stamp,
        })
        batch.associations.set(key, association)
        batch.newAssociations.push(association)
      }
      const memberKey = `${farmer._id}|${association._id}`
      if (!batch.memberKeys.has(memberKey)) {
        batch.memberKeys.add(memberKey)
        batch.members.push(
          new AssociationMember({
            farmerId: farmer._id,
            associationId: association._id,
            ...stamp,
          }),
        )
        bump('memberships')
      }
    }

    const farmBarangay =
      batch.barangays.get(`${town._id}|${normalizeName(row.farmBarangay)}`) ?? home
    const farm = new Farm({
      farmerId: farmer._id,
      barangayId: farmBarangay._id,
      municipalityId: town._id,
      locationRaw: row.locationRaw,
      ...stamp,
    })
    batch.farms.push(farm)
    const stand = new CropStand({
      farmId: farm._id,
      commodityId: commodity._id,
      barangayId: farmBarangay._id,
      municipalityId: town._id,
      programId: commodity.programId,
      ...stamp,
    })
    batch.stands.push(stand)
    bump('farms')
    bump('plantings', addPlantings(batch, stand, row, actor))

    const approved = !row.incomplete
    const record = new InventoryRecord({
      surveyRoundId: round._id,
      cropStandId: stand._id,
      barangayId: stand.barangayId,
      municipalityId: stand.municipalityId,
      programId: stand.programId,
      status: approved ? 'approved' : 'draft',
      encodedById: actor.id,
      approvedById: approved ? actor.id : null,
      approvedAt: approved ? now : null,
      remarks: row.remarks,
      flags: {
        source: 'legacy_import',
        import_job: job._id,
        sheet: row.sheet,
        row: row.row,
        below_total: row.incomplete,
        missing: row.missing,
        issues: row.issues,
        raw: { variety: row.rawVariety, source: row.rawSource, date_planted: row.rawDate },
      },
      stageCounts: Object.entries(row.counts).flatMap(([code, count]) => {
        const stage = stages.get(code)
        return count !== null && stage ? [{ growthStageId: stage._id, count }] : []
      }),
      ...stamp,
    })
    batch.records.push(record)
    bump(approved ? 'records_approved' : 'records_draft')
    for (const harvest of row.harvests) {
      batch.harvests.push(
        new Harvest({
          cropStandId: stand._id,
          barangayId: stand.barangayId,
          municipalityId: stand.municipalityId,
          programId: stand.programId,
          dateEstimated: true,
          quantity: toDecimal128(harvest.quantity),
          unit: harvest.unit,
          productForm: harvest.productForm,
          rawText: harvest.rawText + (harvest.recurring ? ' (recurring)' : ''),
          ...stamp,
        }),
      )
      bump('harvests')
    }
    batch.links.push(
      new ImportRowLink({
        fileSha256: job.fileSha256,
        sheet: row.sheet,
        row: row.row,
        jobId: job._id,
        farmerId: farmer._id,
        farmId: farm._id,
        cropStandId: stand._id,
        recordId: record._id,
      }),
    )
  }

  // Sequential writes, because a transaction allows only one operation at a time.
  await Barangay.insertMany(batch.newBarangays, { session })
  await Association.insertMany(batch.newAssociations, { session })
  await Farmer.insertMany(batch.newFarmers, { session })
  await AssociationMember.insertMany(batch.members, { session })
  await Farm.insertMany(batch.farms, { session })
  await CropStand.insertMany(batch.stands, { session })
  await Planting.insertMany(batch.plantings, { session })
  await InventoryRecord.insertMany(batch.records, { session })
  await Harvest.insertMany(batch.harvests, { session })
  await ImportRowLink.insertMany(batch.links, { session })

  const imported = { after: { import_job: job._id } }
  await recordAuditMany(
    [
      ...batch.newFarmers.map((row: FarmerDoc) => ({
        actorId: actor.id,
        action: 'farmer.import',
        objectType: 'farmer',
        objectId: row._id,
        ...imported,
      })),
      ...batch.records.map((row) => ({
        actorId: actor.id,
        action: 'inventory.import',
        objectType: 'inventory_record',
        objectId: row._id,
        ...imported,
      })),
    ],
    session,
  )

  const totals = await stageTotals(round, FULL_SCOPE, session)
  const byTown: Record<string, Record<string, number>> = {}
  for (const total of totals) {
    ;(byTown[total.municipality] ??= {})[total.stageCode] = total.count
  }
  return {
    ...tally,
    new_barangays: batch.newBarangays.length,
    new_associations: batch.newAssociations.length,
    survey_round: round._id,
    official_total: totals.reduce((sum, total) => sum + total.count, 0),
    official_by_municipality: byTown,
  }
}
