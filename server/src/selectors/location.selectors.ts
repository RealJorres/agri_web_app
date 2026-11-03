import { notFound } from '../lib/errors.js'
import { orderRows, type SortFields } from '../lib/ordering.js'
import { normalizeName } from '../lib/text.js'
import {
  Barangay,
  Municipality,
  type BarangayDoc,
  type MunicipalityDoc,
} from '../models/location.models.js'

function municipalityView(row: MunicipalityDoc) {
  return { id: row._id, name: row.name, psgc_code: row.psgcCode }
}
type MunicipalityView = ReturnType<typeof municipalityView>

const MUNICIPALITY_ORDER: SortFields<MunicipalityView> = {
  id: (row) => row.id,
  name: (row) => row.name,
  psgc_code: (row) => row.psgc_code,
}

export async function listMunicipalities(ordering?: unknown): Promise<MunicipalityView[]> {
  const rows = await Municipality.find().lean<MunicipalityDoc[]>()
  return orderRows(rows.map(municipalityView), ordering, MUNICIPALITY_ORDER, ['name'])
}

export async function getMunicipality(id: string): Promise<MunicipalityView> {
  const row = await Municipality.findOne({ _id: id }).lean<MunicipalityDoc>()
  if (!row) throw notFound()
  return municipalityView(row)
}

function barangayView(row: BarangayDoc) {
  return {
    id: row._id,
    name: row.name,
    psgc_code: row.psgcCode,
    municipality: row.municipalityId,
    is_verified: row.isVerified,
  }
}

export interface BarangayFilters {
  municipality?: string | undefined
  isVerified?: boolean | undefined
  q?: string | undefined
}

export async function listBarangays(
  filters: BarangayFilters,
  ordering?: unknown,
): Promise<ReturnType<typeof barangayView>[]> {
  const [rows, municipalities] = await Promise.all([
    Barangay.find({
      ...(filters.municipality ? { municipalityId: filters.municipality } : {}),
      ...(filters.isVerified === undefined ? {} : { isVerified: filters.isVerified }),
    }).lean<BarangayDoc[]>(),
    Municipality.find().lean<MunicipalityDoc[]>(),
  ])
  const needle = normalizeName(filters.q)
  const matching = needle ? rows.filter((row) => row.normalizedName.includes(needle)) : rows
  const townName = new Map(municipalities.map((town) => [town._id, town.name]))
  const fields: SortFields<BarangayDoc> = {
    id: (row) => row._id,
    name: (row) => row.name,
    psgc_code: (row) => row.psgcCode,
    municipality: (row) => townName.get(row.municipalityId) ?? null,
    is_verified: (row) => row.isVerified,
  }
  return orderRows(matching, ordering, fields, ['municipality', 'name']).map(barangayView)
}

export async function getBarangay(id: string): Promise<ReturnType<typeof barangayView>> {
  const row = await Barangay.findOne({ _id: id }).lean<BarangayDoc>()
  if (!row) throw notFound()
  return barangayView(row)
}

/** ADR-0005: codes come only from the official PSGC file. Names the towns still waiting for it. */
export async function municipalitiesWithoutPsgc(): Promise<string[]> {
  const rows = await Municipality.find({ psgcCode: null })
    .sort({ name: 1 })
    .lean<MunicipalityDoc[]>()
  return rows.map((row) => row.name)
}
