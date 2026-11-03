import type { Request, Response } from 'express'

import { DomainError, notFound } from '../lib/errors.js'
import { Cap } from '../lib/roles.js'
import { canReach } from '../lib/scoping.js'
import { inTransaction } from '../lib/transaction.js'
import { Commodity } from '../models/catalog.models.js'
import { Municipality } from '../models/location.models.js'
import * as analytics from '../selectors/analytics.selectors.js'
import * as map from '../selectors/map.selectors.js'
import { municipalListContent, reportLogo, summaryContent } from '../selectors/report.selectors.js'
import { roundForViewer } from '../selectors/survey.selectors.js'
import { recordAudit } from '../services/audit.service.js'
import { signOffSummary, signoffStatus, type SignoffStatus } from '../services/report.service.js'
import {
  municipalListPdf,
  municipalListXlsx,
  summaryPdf,
  summaryXlsx,
} from '../services/reportRender.js'
import { User } from '../models/account.models.js'
import {
  harvestQuery,
  levelQuery,
  municipalityQuery,
  trendsQuery,
} from '../validators/analytics.validators.js'
import { actorOf, pathId, scopeOf } from './helpers.js'

// --- Analytics

export async function overview(req: Request, res: Response): Promise<void> {
  res.json(await analytics.overview(scopeOf(req), pathId(req), municipalityQuery.parse(req.query)))
}

export async function breakdown(req: Request, res: Response): Promise<void> {
  const { level, municipality } = levelQuery.parse(req.query)
  res.json(await analytics.breakdown(scopeOf(req), pathId(req), level, { municipality }))
}

export async function distribution(req: Request, res: Response): Promise<void> {
  res.json(
    await analytics.distribution(scopeOf(req), pathId(req), municipalityQuery.parse(req.query)),
  )
}

export async function trends(req: Request, res: Response): Promise<void> {
  const { commodity, municipality } = trendsQuery.parse(req.query)
  if (!(await Commodity.exists({ _id: commodity }))) {
    throw new DomainError('validation_error', 'Some fields are invalid.', {
      commodity: ['This does not exist.'],
    })
  }
  res.json(await analytics.trends(scopeOf(req), commodity, { municipality }))
}

export async function status(_req: Request, res: Response): Promise<void> {
  res.json(await analytics.dataStatus())
}

export async function harvests(req: Request, res: Response): Promise<void> {
  res.json(await analytics.harvestSummary(scopeOf(req), harvestQuery.parse(req.query)))
}

// --- Map

export async function mapConfig(_req: Request, res: Response): Promise<void> {
  res.json(await map.mapConfig())
}

export async function mapBoundaries(req: Request, res: Response): Promise<void> {
  const { level, municipality } = levelQuery.parse(req.query)
  res.json(await map.boundaryFeatures({ level, municipality }))
}

// --- Reports

const CONTENT_TYPES: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
}

function formatOf(req: Request): 'xlsx' | 'pdf' {
  const fmt = String(req.params.fmt)
  if (fmt !== 'xlsx' && fmt !== 'pdf') throw notFound()
  return fmt
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '-')
    .replace(/^-+|-+$/gu, '')
}

function sendFile(res: Response, data: Buffer, filename: string, fmt: string): void {
  res
    .set({
      'Content-Type': CONTENT_TYPES[fmt] ?? 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    })
    .send(data)
}

/** The provincial summary, aggregates only, limited to the caller's assignment. */
export async function summaryFile(req: Request, res: Response): Promise<void> {
  const fmt = formatOf(req)
  const round = await roundForViewer(scopeOf(req), pathId(req))
  const content = await summaryContent(round, scopeOf(req))
  const data =
    fmt === 'xlsx' ? await summaryXlsx(content) : await summaryPdf(content, await reportLogo())
  sendFile(res, data, `summary-${slug(round.name)}.${fmt}`, fmt)
}

/** The farmer-level list: personal data, so it needs the export capability and is audited. */
export async function municipalListFile(req: Request, res: Response): Promise<void> {
  const fmt = formatOf(req)
  const scope = scopeOf(req)
  const round = await roundForViewer(scope, pathId(req))
  const id = typeof req.query.municipality === 'string' ? req.query.municipality : ''
  const town = await Municipality.findOne({ _id: id }).lean()
  const reach = { municipalityId: town?._id ?? null }
  if (!town || !canReach(scope, Cap.EXPORT_PERSONAL_DATA, reach)) throw notFound()
  const content = await municipalListContent(round, scope, town._id)
  const data =
    fmt === 'xlsx'
      ? await municipalListXlsx(content)
      : await municipalListPdf(content, await reportLogo())
  const actor = actorOf(req)
  await inTransaction((session) =>
    recordAudit({
      actorId: actor.id,
      action: 'export.municipal_list',
      objectType: 'survey_round',
      objectId: round._id,
      after: { municipality: town.name, format: fmt, rows: content.rows.length },
      session,
    }),
  )
  sendFile(res, data, `${slug(town.name)}-${slug(round.name)}.${fmt}`, fmt)
}

async function signoffView(status_: SignoffStatus) {
  const { signoff } = status_
  const signer = signoff ? await User.findOne({ _id: signoff.signedById }).lean() : null
  const name = signer ? `${signer.firstName} ${signer.lastName}`.trim() || signer.email : null
  return {
    state: status_.state,
    signed_by: name,
    signed_at: signoff?.signedAt.toISOString() ?? null,
    content_sha256: signoff?.contentSha256 ?? null,
    current_sha256: status_.currentSha256,
  }
}

export async function getSignoff(req: Request, res: Response): Promise<void> {
  const round = await roundForViewer(scopeOf(req), pathId(req))
  res.json(await signoffView(await signoffStatus(round)))
}

export async function signOff(req: Request, res: Response): Promise<void> {
  const round = await roundForViewer(scopeOf(req), pathId(req))
  await signOffSummary({ actor: actorOf(req), roundId: round._id })
  res.status(201).json(await signoffView(await signoffStatus(round)))
}
