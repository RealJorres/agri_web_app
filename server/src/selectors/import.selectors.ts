import { notFound } from '../lib/errors.js'
import { orderRows, type SortFields } from '../lib/ordering.js'
import type { PageRequest } from '../lib/pagination.js'
import { Cap } from '../lib/roles.js'
import type { Actor } from '../lib/scoping.js'
import { User } from '../models/account.models.js'
import { ImportJob, type ImportJobDoc } from '../models/import.models.js'

/** Admins see every job, and others their own, because summaries hold personal data. */
function jobFilter(actor: Actor): Record<string, unknown> {
  return actor.scope.can(Cap.ADMIN) ? {} : { uploadedById: actor.id }
}

async function uploaderNames(rows: ImportJobDoc[]): Promise<Map<string, string>> {
  const users = await User.find({ _id: { $in: rows.map((row) => row.uploadedById) } }).lean()
  return new Map(
    users.map((user) => [user._id, `${user.firstName} ${user.lastName}`.trim() || user.email]),
  )
}

function jobListView(row: ImportJobDoc, names: Map<string, string>) {
  return {
    id: row._id,
    kind: row.kind,
    status: row.status,
    original_name: row.originalName,
    file_size: row.fileSize,
    commodity: row.commodityId,
    survey_round: row.surveyRoundId,
    uploaded_by: names.get(row.uploadedById) ?? '',
    created_at: row.createdAt.toISOString(),
    committed_at: row.committedAt?.toISOString() ?? null,
    error_message: row.errorMessage,
    has_error_report: Boolean(row.errorReportPath),
  }
}

const JOB_ORDER: SortFields<ImportJobDoc> = {
  id: (row) => row._id,
  kind: (row) => row.kind,
  status: (row) => row.status,
  original_name: (row) => row.originalName,
  file_size: (row) => row.fileSize,
  created_at: (row) => row.createdAt.getTime(),
  committed_at: (row) => row.committedAt?.getTime() ?? null,
}

export async function listJobs(actor: Actor, page: PageRequest, ordering: unknown) {
  const rows = await ImportJob.find(jobFilter(actor)).select('-summary').lean<ImportJobDoc[]>()
  const ordered = orderRows(rows, ordering, JOB_ORDER, ['-created_at'])
  const pageRows = ordered.slice(page.skip, page.skip + page.pageSize)
  const names = await uploaderNames(pageRows)
  return { count: ordered.length, results: pageRows.map((row) => jobListView(row, names)) }
}

export async function jobById(actor: Actor, id: string): Promise<ImportJobDoc> {
  const row = await ImportJob.findOne({ ...jobFilter(actor), _id: id }).lean<ImportJobDoc>()
  if (!row) throw notFound()
  return row
}

export async function getJob(actor: Actor, id: string) {
  const row = await jobById(actor, id)
  return { ...jobListView(row, await uploaderNames([row])), summary: row.summary }
}
