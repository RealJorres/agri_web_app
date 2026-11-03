import { dateOnly } from '../lib/dates.js'
import { notFound } from '../lib/errors.js'
import { orderRows, type SortFields } from '../lib/ordering.js'
import type { PageRequest } from '../lib/pagination.js'
import { Cap } from '../lib/roles.js'
import { scopeFilter, within, type Scope } from '../lib/scoping.js'
import { normalizeName, normalizePersonName } from '../lib/text.js'
import { similarity } from '../lib/trigram.js'
import { Barangay, Municipality, type BarangayDoc } from '../models/location.models.js'
import {
  Association,
  ASSOCIATION_SCOPE,
  type AssociationDoc,
  AssociationMember,
  type AssociationMemberDoc,
  Farmer,
  farmerDisplayName,
  FARMER_SCOPE,
  type FarmerDoc,
} from '../models/registry.models.js'

/** Duplicate thresholds (ADR-0007): the farmer form warns at 0.85 and suggests from 0.6. */
export const DUPLICATE_WARN_SIMILARITY = 0.85
export const DUPLICATE_SUGGEST_SIMILARITY = 0.6
const SEARCH_SIMILARITY = 0.3

const FARMER_PERSONAL_KEYS = [
  'display_name',
  'first_name',
  'middle_name',
  'last_name',
  'suffix',
  'full_name_raw',
  'normalized_name',
  'sex',
  'birth_year',
  'rsbsa_no',
  'contact_no',
] as const

/** Drops personal fields unless the requester may view them (ADR-0010). */
export function hidePersonal<View extends object>(
  scope: Scope,
  view: View,
  keys: readonly string[],
): View {
  if (scope.can(Cap.VIEW_PERSONAL_DATA)) return view
  const hidden = new Set(keys)
  return Object.fromEntries(Object.entries(view).filter(([key]) => !hidden.has(key))) as View
}

export interface LocationRefs {
  barangay: { id: string; name: string }
  municipality: { id: string; name: string }
}

export async function locationRefs(barangayIds: Iterable<string>) {
  const barangays = await Barangay.find({ _id: { $in: [...new Set(barangayIds)] } }).lean<
    BarangayDoc[]
  >()
  const towns = await Municipality.find({
    _id: { $in: [...new Set(barangays.map((row) => row.municipalityId))] },
  }).lean()
  const townName = new Map(towns.map((town) => [town._id, town.name]))
  return new Map<string, LocationRefs>(
    barangays.map((row) => [
      row._id,
      {
        barangay: { id: row._id, name: row.name },
        municipality: { id: row.municipalityId, name: townName.get(row.municipalityId) ?? '' },
      },
    ]),
  )
}

const MISSING_REF = { id: '', name: '' }

function farmerView(row: FarmerDoc, refs: Map<string, LocationRefs>) {
  const location = refs.get(row.homeBarangayId)
  return {
    id: row._id,
    display_name: farmerDisplayName(row),
    first_name: row.firstName,
    middle_name: row.middleName,
    last_name: row.lastName,
    suffix: row.suffix,
    full_name_raw: row.fullNameRaw,
    sex: row.sex,
    birth_year: row.birthYear,
    rsbsa_no: row.rsbsaNo,
    contact_no: row.contactNo,
    home_barangay: location?.barangay ?? MISSING_REF,
    municipality: location?.municipality ?? MISSING_REF,
    status: row.status,
    has_consent: row.consentAt !== null,
    consent_at: row.consentAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }
}

export async function farmerViews(scope: Scope, rows: FarmerDoc[]) {
  const refs = await locationRefs(rows.map((row) => row.homeBarangayId))
  return rows.map((row) => hidePersonal(scope, farmerView(row, refs), FARMER_PERSONAL_KEYS))
}

function requiredView<T>(views: T[]): T {
  const [view] = views
  if (view === undefined) throw notFound()
  return view
}

/** The list shape of one farmer, which is what writes respond with. */
export async function getFarmerRow(scope: Scope, id: string) {
  const row = await farmerById(scope, id)
  return requiredView(await farmerViews(scope, [row]))
}

async function farmerById(scope: Scope, id: string): Promise<FarmerDoc> {
  const visible = scopeFilter(scope, Cap.VIEW_RECORDS, FARMER_SCOPE)
  const row = await Farmer.findOne(within(visible, { _id: id })).lean<FarmerDoc>()
  if (!row) throw notFound()
  return row
}

/** Raises a 404 unless the farmer exists and is in the requester's scope. */
export async function requireFarmer(scope: Scope, id: string): Promise<void> {
  await farmerById(scope, id)
}

export async function getFarmerDetail(scope: Scope, id: string) {
  const row = await farmerById(scope, id)
  const view = requiredView(await farmerViews(scope, [row]))
  const memberships = await AssociationMember.find({ farmerId: id }).lean<AssociationMemberDoc[]>()
  const associations = await Association.find({
    _id: { $in: memberships.map((member) => member.associationId) },
  }).lean<AssociationDoc[]>()
  const associationName = new Map(associations.map((item) => [item._id, item.name]))
  const items = memberships.map((member) => ({
    id: member._id,
    association: {
      id: member.associationId,
      name: associationName.get(member.associationId) ?? '',
    },
    role: member.role,
    since: dateOnly(member.since),
  }))
  return {
    ...view,
    memberships: orderRows(items, undefined, { name: (item) => item.association.name }, ['name']),
  }
}

export interface FarmerFilters {
  q?: string | undefined
  municipality?: string | undefined
  barangay?: string | undefined
  association?: string | undefined
  status?: string | undefined
}

type RankedFarmer = FarmerDoc & { similarity?: number }

const FARMER_ORDER: SortFields<RankedFarmer> = {
  last_name: (row) => row.lastName,
  first_name: (row) => row.firstName,
  created_at: (row) => row.createdAt.getTime(),
  updated_at: (row) => row.updatedAt.getTime(),
  status: (row) => row.status,
  similarity: (row) => row.similarity ?? 0,
}

/** Rows matching a name or RSBSA search, tolerant of spelling variants, each with its score. */
export function searchRows<Row extends Pick<FarmerDoc, 'normalizedName' | 'rsbsaNo'>>(
  rows: Row[],
  text: string,
): (Row & { similarity: number })[] {
  const needle = normalizePersonName(text)
  const rsbsa = text.trim().toUpperCase()
  return rows.flatMap((row) => {
    const score = similarity(row.normalizedName, needle)
    const matches =
      row.normalizedName.includes(needle) || score >= SEARCH_SIMILARITY || row.rsbsaNo === rsbsa
    return matches ? [{ ...row, similarity: score }] : []
  })
}

async function matchingFarmers(
  scope: Scope,
  filters: FarmerFilters,
): Promise<{ matching: RankedFarmer[]; searching: boolean }> {
  const conditions: Record<string, unknown>[] = []
  if (filters.municipality) conditions.push({ municipalityId: filters.municipality })
  if (filters.barangay) conditions.push({ homeBarangayId: filters.barangay })
  if (filters.status) conditions.push({ status: filters.status })
  if (filters.association) {
    const members = await AssociationMember.find({ associationId: filters.association })
      .select('farmerId')
      .lean()
    conditions.push({ _id: { $in: members.map((member) => member.farmerId) } })
  }
  const visible = scopeFilter(scope, Cap.VIEW_RECORDS, FARMER_SCOPE)
  const rows = await Farmer.find(within(visible, ...conditions))
    .select('lastName firstName createdAt updatedAt status normalizedName rsbsaNo')
    .lean<RankedFarmer[]>()

  const searching = normalizePersonName(filters.q) !== ''
  return { matching: searching ? searchRows(rows, filters.q ?? '') : rows, searching }
}

export async function listFarmers(
  scope: Scope,
  filters: FarmerFilters,
  page: PageRequest,
  ordering: unknown,
) {
  const { matching, searching } = await matchingFarmers(scope, filters)
  const defaults = searching
    ? ['-similarity', 'last_name', 'first_name']
    : ['last_name', 'first_name']
  const ordered = orderRows(matching, ordering, FARMER_ORDER, defaults)
  const pageIds = ordered.slice(page.skip, page.skip + page.pageSize).map((row) => row._id)
  const full = await Farmer.find({ _id: { $in: pageIds } }).lean<FarmerDoc[]>()
  const byId = new Map(full.map((row) => [row._id, row]))
  const pageRows = pageIds.flatMap((id) => byId.get(id) ?? [])
  return { count: matching.length, results: await farmerViews(scope, pageRows) }
}

const MAX_EXPORT_ROWS = 20_000

/** Farmers in scope matching the filters, as rows for the personal-data export. */
export async function exportFarmerRows(scope: Scope, filters: FarmerFilters) {
  const { matching } = await matchingFarmers(scope, filters)
  const full = await Farmer.find({ _id: { $in: matching.map((row) => row._id) } }).lean<
    FarmerDoc[]
  >()
  const refs = await locationRefs(full.map((row) => row.homeBarangayId))
  const ordered = orderRows(
    full,
    undefined,
    {
      town: (row) => refs.get(row.homeBarangayId)?.municipality.name ?? null,
      last: (row) => row.lastName,
      first: (row) => row.firstName,
    },
    ['town', 'last', 'first'],
  ).slice(0, MAX_EXPORT_ROWS)
  const members = await AssociationMember.find({
    farmerId: { $in: ordered.map((row) => row._id) },
  }).lean<AssociationMemberDoc[]>()
  const associations = await Association.find({
    _id: { $in: members.map((member) => member.associationId) },
  }).lean<AssociationDoc[]>()
  const associationName = new Map(associations.map((row) => [row._id, row.name]))
  return ordered.map((row) => [
    row.lastName,
    row.firstName,
    row.middleName,
    row.suffix,
    row.sex,
    row.birthYear,
    row.rsbsaNo,
    row.contactNo,
    refs.get(row.homeBarangayId)?.barangay.name ?? '',
    refs.get(row.homeBarangayId)?.municipality.name ?? '',
    members
      .filter((member) => member.farmerId === row._id)
      .map((member) => associationName.get(member.associationId) ?? '')
      .join('; '),
    row.status,
    row.consentAt ? 'Y' : '',
  ])
}

export interface DuplicateCandidate {
  farmer: FarmerDoc
  similarity: number
  reason: 'rsbsa' | 'name'
}

/**
 * Likely duplicates within the municipality (trigrams on normalized names), or anywhere with the
 * same RSBSA number (ADR-0007). `visible` decides what may be seen: scope it for API callers.
 */
export async function findDuplicateFarmers(
  visible: Record<string, unknown>,
  {
    name,
    municipalityId,
    rsbsaNo,
    excludeId,
    threshold = DUPLICATE_SUGGEST_SIMILARITY,
    limit = 10,
  }: {
    name: string
    municipalityId?: string | undefined
    rsbsaNo?: string | undefined
    excludeId?: string | undefined
    threshold?: number
    limit?: number
  },
): Promise<DuplicateCandidate[]> {
  const others = excludeId ? { _id: { $ne: excludeId } } : {}
  const results = new Map<string, DuplicateCandidate>()

  const wanted = rsbsaNo?.trim().toUpperCase()
  if (wanted) {
    const sameNumber = await Farmer.find(within(visible, others, { rsbsaNo: wanted }))
      .limit(limit)
      .lean<FarmerDoc[]>()
    for (const farmer of sameNumber) {
      results.set(farmer._id, { farmer, similarity: 1, reason: 'rsbsa' })
    }
  }

  const needle = normalizePersonName(name)
  if (needle) {
    const place = municipalityId ? { municipalityId } : {}
    const candidates = await Farmer.find(within(visible, others, place)).lean<FarmerDoc[]>()
    const scored = candidates
      .map((farmer) => ({ farmer, score: similarity(farmer.normalizedName, needle) }))
      .filter(({ score }) => score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
    for (const { farmer, score } of scored) {
      if (!results.has(farmer._id)) {
        results.set(farmer._id, {
          farmer,
          similarity: Number(score.toFixed(3)),
          reason: 'name',
        })
      }
    }
  }
  return [...results.values()].sort((a, b) => b.similarity - a.similarity).slice(0, limit)
}

export async function duplicateCandidates(
  scope: Scope,
  params: { name?: string; barangay?: string; rsbsaNo?: string; exclude?: string },
) {
  let municipalityId: string | undefined
  if (params.barangay) {
    const barangay = await Barangay.findOne({ _id: params.barangay }).lean<BarangayDoc>()
    if (!barangay) throw notFound()
    municipalityId = barangay.municipalityId
  }
  const candidates = await findDuplicateFarmers(
    scopeFilter(scope, Cap.VIEW_RECORDS, FARMER_SCOPE),
    {
      name: params.name ?? '',
      municipalityId,
      rsbsaNo: params.rsbsaNo,
      excludeId: params.exclude,
    },
  )
  const refs = await locationRefs(candidates.map(({ farmer }) => farmer.homeBarangayId))
  return candidates.map(({ farmer, similarity: score, reason }) => ({
    id: farmer._id,
    display_name: farmerDisplayName(farmer),
    home_barangay: refs.get(farmer.homeBarangayId)?.barangay.name ?? '',
    municipality: refs.get(farmer.homeBarangayId)?.municipality.name ?? '',
    similarity: score,
    reason,
  }))
}

// --- Associations

async function associationViews(rows: AssociationDoc[]) {
  const ids = rows.map((row) => row._id)
  const counts = await AssociationMember.aggregate<{ _id: string; count: number }>([
    { $match: { associationId: { $in: ids }, isDeleted: false } },
    { $group: { _id: '$associationId', count: { $sum: 1 } } },
  ])
  const countOf = new Map(counts.map((row) => [row._id, row.count]))
  const towns = await Municipality.find({
    _id: { $in: rows.map((row) => row.municipalityId) },
  }).lean()
  const townName = new Map(towns.map((town) => [town._id, town.name]))
  return rows.map((row) => ({
    id: row._id,
    name: row.name,
    short_name: row.shortName,
    type: row.type,
    municipality: row.municipalityId,
    municipality_name: townName.get(row.municipalityId) ?? '',
    registration_body: row.registrationBody,
    registration_no: row.registrationNo,
    member_count: countOf.get(row._id) ?? 0,
  }))
}

const ASSOCIATION_ORDER: SortFields<AssociationDoc> = {
  name: (row) => row.name,
  created_at: (row) => row.createdAt.getTime(),
}

export async function listAssociations(
  scope: Scope,
  filters: { municipality?: string | undefined; q?: string | undefined; type?: string | undefined },
  page: PageRequest,
  ordering: unknown,
) {
  const conditions: Record<string, unknown>[] = []
  if (filters.municipality) conditions.push({ municipalityId: filters.municipality })
  if (filters.type) conditions.push({ type: filters.type })
  const visible = scopeFilter(scope, Cap.VIEW_RECORDS, ASSOCIATION_SCOPE)
  const rows = await Association.find(within(visible, ...conditions)).lean<AssociationDoc[]>()
  const needle = normalizeName(filters.q)
  const matching = needle ? rows.filter((row) => row.normalizedName.includes(needle)) : rows
  const ordered = orderRows(matching, ordering, ASSOCIATION_ORDER, ['name'])
  return {
    count: ordered.length,
    results: await associationViews(ordered.slice(page.skip, page.skip + page.pageSize)),
  }
}

async function associationById(scope: Scope, id: string): Promise<AssociationDoc> {
  const visible = scopeFilter(scope, Cap.VIEW_RECORDS, ASSOCIATION_SCOPE)
  const row = await Association.findOne(within(visible, { _id: id })).lean<AssociationDoc>()
  if (!row) throw notFound()
  return row
}

export async function getAssociation(scope: Scope, id: string) {
  return requiredView(await associationViews([await associationById(scope, id)]))
}

export async function requireAssociation(scope: Scope, id: string): Promise<void> {
  await associationById(scope, id)
}

async function memberViews(scope: Scope, rows: AssociationMemberDoc[]) {
  const farmers = await Farmer.find({ _id: { $in: rows.map((row) => row.farmerId) } }).lean<
    FarmerDoc[]
  >()
  const farmerById = new Map(farmers.map((farmer) => [farmer._id, farmer]))
  const refs = await locationRefs(farmers.map((farmer) => farmer.homeBarangayId))
  return rows.map((row) => {
    const farmer = farmerById.get(row.farmerId)
    const view = {
      id: row._id,
      farmer: row.farmerId,
      farmer_name: farmer ? farmerDisplayName(farmer) : '',
      home_barangay: farmer ? (refs.get(farmer.homeBarangayId)?.barangay.name ?? '') : '',
      role: row.role,
      since: dateOnly(row.since),
    }
    return hidePersonal(scope, view, ['farmer_name'])
  })
}

export async function listMembers(scope: Scope, associationId: string, page: PageRequest) {
  await requireAssociation(scope, associationId)
  const rows = await AssociationMember.find({ associationId }).lean<AssociationMemberDoc[]>()
  const farmers = await Farmer.find({ _id: { $in: rows.map((row) => row.farmerId) } })
    .select('lastName firstName')
    .lean<FarmerDoc[]>()
  const farmerById = new Map(farmers.map((farmer) => [farmer._id, farmer]))
  const ordered = orderRows(
    rows,
    undefined,
    {
      last: (row) => farmerById.get(row.farmerId)?.lastName ?? null,
      first: (row) => farmerById.get(row.farmerId)?.firstName ?? null,
    },
    ['last', 'first'],
  )
  return {
    count: ordered.length,
    results: await memberViews(scope, ordered.slice(page.skip, page.skip + page.pageSize)),
  }
}

export async function getMember(scope: Scope, memberId: string) {
  const row = await AssociationMember.findOne({ _id: memberId }).lean<AssociationMemberDoc>()
  if (!row) throw notFound()
  return requiredView(await memberViews(scope, [row]))
}
