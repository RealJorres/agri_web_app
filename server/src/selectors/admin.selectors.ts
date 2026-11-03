import { notFound } from '../lib/errors.js'
import type { PageRequest } from '../lib/pagination.js'
import { User, type UserDoc } from '../models/account.models.js'
import {
  Commodity,
  GrowthStage,
  MaterialSource,
  Variety,
  type GrowthStageDoc,
  type MaterialSourceDoc,
  type VarietyDoc,
} from '../models/catalog.models.js'
import {
  DEFAULT_LETTERHEAD,
  DEFAULT_PROGRAM_LINE,
  ReportSettings,
  Signatory,
  type SignatoryDoc,
} from '../models/report.models.js'
import { assignmentViews } from './accounts.selectors.js'
import { sourceView, stageView, varietyView } from './catalog.selectors.js'

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

async function userView(user: UserDoc) {
  return {
    id: user._id,
    email: user.email,
    first_name: user.firstName,
    last_name: user.lastName,
    full_name: `${user.firstName} ${user.lastName}`.trim(),
    is_active: user.isActive,
    is_superuser: user.isSuperuser,
    last_login_at: user.lastLoginAt?.toISOString() ?? null,
    assignments: await assignmentViews(user._id),
  }
}

export async function listUsers(
  { q }: { q?: string | undefined },
  page: PageRequest,
): Promise<{ count: number; results: Awaited<ReturnType<typeof userView>>[] }> {
  const term = q?.trim()
  const pattern = term ? new RegExp(escapeRegex(term), 'iu') : null
  const filter = pattern
    ? { $or: [{ email: pattern }, { firstName: pattern }, { lastName: pattern }] }
    : {}
  const [count, rows] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter)
      .sort({ lastName: 1, firstName: 1, email: 1 })
      .skip(page.skip)
      .limit(page.pageSize)
      .lean<UserDoc[]>(),
  ])
  return { count, results: await Promise.all(rows.map(userView)) }
}

export async function getUser(id: string): Promise<Awaited<ReturnType<typeof userView>>> {
  const user = await User.findById(id).lean<UserDoc>()
  if (!user) throw notFound()
  return userView(user)
}

// Import spellings are only for the people who maintain them, so public views leave them out.

export function adminStageView(row: GrowthStageDoc) {
  return { ...stageView(row), aliases: row.aliases }
}

export function adminVarietyView(row: VarietyDoc) {
  return { ...varietyView(row), aliases: row.aliases }
}

export function adminSourceView(row: MaterialSourceDoc) {
  return { ...sourceView(row), aliases: row.aliases }
}

export async function listStages(commodityId: string) {
  if (!(await Commodity.exists({ _id: commodityId }))) throw notFound()
  const rows = await GrowthStage.find({ commodityId })
    .sort({ sortOrder: 1 })
    .lean<GrowthStageDoc[]>()
  return rows.map(adminStageView)
}

export async function listVarieties(commodityId?: string) {
  const query = commodityId ? { commodityId } : {}
  const rows = await Variety.find(query).sort({ code: 1 }).lean<VarietyDoc[]>()
  return rows.map(adminVarietyView)
}

export async function listSources() {
  const rows = await MaterialSource.find().sort({ code: 1 }).lean<MaterialSourceDoc[]>()
  return rows.map(adminSourceView)
}

export async function reportSettingsView() {
  const settings = await ReportSettings.findById('current').lean()
  return {
    letterhead: settings?.letterhead ?? DEFAULT_LETTERHEAD,
    program_line: settings?.programLine ?? DEFAULT_PROGRAM_LINE,
    has_logo: Boolean(settings?.logoPath),
  }
}

export function signatoryView(row: SignatoryDoc) {
  return {
    id: row._id,
    report_kind: row.reportKind,
    order: row.order,
    caption: row.caption,
    name: row.name,
    title: row.title,
  }
}

export async function listSignatories(): Promise<ReturnType<typeof signatoryView>[]> {
  const rows = await Signatory.find().sort({ reportKind: 1, order: 1 }).lean<SignatoryDoc[]>()
  return rows.map(signatoryView)
}
