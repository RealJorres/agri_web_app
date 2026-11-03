import type { NextFunction, Request, Response } from 'express'
import multer, { MulterError } from 'multer'

import { runInBackground } from '../lib/background.js'
import { DomainError, notFound } from '../lib/errors.js'
import { logger, safeErrorDetails } from '../lib/logger.js'
import { pageOf, pageRequest } from '../lib/pagination.js'
import { readPrivateFile } from '../lib/privateFiles.js'
import { inTransaction } from '../lib/transaction.js'
import { Commodity, type CommodityDoc } from '../models/catalog.models.js'
import { getJob, jobById, listJobs } from '../selectors/import.selectors.js'
import { recordAudit } from '../services/audit.service.js'
import { exportFarmers, exportInventory } from '../services/imports/exports.service.js'
import {
  checkCommitRights,
  commitJob,
  createJob,
  runPreview,
} from '../services/imports/jobs.service.js'
import { generateTemplate } from '../services/imports/template.js'
import { MAX_UPLOAD_BYTES, rejectUpload } from '../services/imports/uploads.js'
import { commitBody, templateQuery, uploadBody } from '../validators/import.validators.js'
import { farmerQuery } from '../validators/registry.validators.js'
import { recordQuery } from '../validators/survey.validators.js'
import { actorOf, pathId, scopeOf } from './helpers.js'

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

function sendWorkbook(res: Response, data: Buffer, filename: string): void {
  res
    .set({
      'Content-Type': XLSX,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    })
    .send(data)
}

// One byte over the limit is kept, so an oversized file gets the same message however it arrives.
const parseUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES + 1, files: 1 },
}).single('file')

export function receiveUpload(req: Request, res: Response, next: NextFunction): void {
  parseUpload(req, res, (error: unknown) => {
    if (error instanceof MulterError) {
      next(
        error.code === 'LIMIT_FILE_SIZE'
          ? rejectUpload('The file is larger than 10 MB.')
          : rejectUpload('The upload could not be read.'),
      )
      return
    }
    next(error)
  })
}

export async function listImports(req: Request, res: Response): Promise<void> {
  const page = pageRequest(req)
  const { count, results } = await listJobs(actorOf(req), page, req.query.ordering)
  res.json(pageOf(req, page, count, results))
}

export async function getImport(req: Request, res: Response): Promise<void> {
  res.json(await getJob(actorOf(req), pathId(req)))
}

export async function createImport(req: Request, res: Response): Promise<void> {
  const body = uploadBody.parse(req.body)
  if (!req.file) throw rejectUpload('Choose a file to upload.')
  const actor = actorOf(req)
  const job = await createJob({
    actor,
    name: req.file.originalname,
    content: req.file.buffer,
    kind: body.kind,
    roundId: body.survey_round,
    commodityId: body.commodity,
    roundName: body.round_name,
    asOfDate: body.as_of_date,
  })
  runInBackground('import.preview', () => runPreview(job._id))
  res.status(201).json(await getJob(actor, job._id))
}

export async function commitImport(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req)
  const job = await jobById(actor, pathId(req))
  const { association_overrides: associationOverrides } = commitBody.parse(req.body)
  if (job.status !== 'ready') {
    throw new DomainError('not_ready', `This import is ${job.status}.`, {}, 409)
  }
  await checkCommitRights(job, actor)
  runInBackground('import.commit', () =>
    commitJob({ jobId: job._id, actor, associationOverrides }).catch((error: unknown) => {
      // The job already records the failure, and there is nothing to retry.
      if (!(error instanceof DomainError)) {
        logger.error('import.commit_rejected', { job: job._id, ...safeErrorDetails(error) })
      }
    }),
  )
  res.status(202).json(await getJob(actor, job._id))
}

export async function downloadErrorReport(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req)
  const job = await jobById(actor, pathId(req))
  if (!job.errorReportPath) throw notFound()
  const data = await readPrivateFile(job.errorReportPath)
  await inTransaction((session) =>
    recordAudit({
      actorId: actor.id,
      action: 'import.download_error_report',
      objectType: 'import_job',
      objectId: job._id,
      session,
    }),
  )
  sendWorkbook(res, data, `import-errors-${job._id}.xlsx`)
}

export async function downloadTemplate(req: Request, res: Response): Promise<void> {
  const { commodity: id } = templateQuery.parse(req.query)
  const commodity = await Commodity.findOne({ _id: id }).lean<CommodityDoc>()
  if (!commodity) {
    throw new DomainError('validation_error', 'Some fields are invalid.', {
      commodity: ['This does not exist.'],
    })
  }
  sendWorkbook(
    res,
    await generateTemplate(commodity),
    `${commodity.code.toLowerCase()}-template.xlsx`,
  )
}

export async function exportFarmerList(req: Request, res: Response): Promise<void> {
  const filters = farmerQuery.parse(req.query)
  sendWorkbook(
    res,
    await exportFarmers(actorOf(req), scopeOf(req), filters, req.query),
    'farmers.xlsx',
  )
}

export async function exportInventoryList(req: Request, res: Response): Promise<void> {
  const filters = recordQuery.parse(req.query)
  sendWorkbook(
    res,
    await exportInventory(actorOf(req), scopeOf(req), filters, req.query),
    'inventory.xlsx',
  )
}
