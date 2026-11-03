/** Location writes: municipality seeding and the official PSGC loader (ADR-0005). */
import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

import { parse as parseCsv } from 'csv-parse/sync'
import ExcelJS from 'exceljs'

import { DomainError } from '../lib/errors.js'
import { collapseSpaces, normalizeName } from '../lib/text.js'
import { inTransaction } from '../lib/transaction.js'
import { cellText } from '../lib/workbook.js'
import {
  Barangay,
  Municipality,
  type BarangayDoc,
  type MunicipalityDoc,
} from '../models/location.models.js'

export const PROVINCE = 'Marinduque'
const MARINDUQUE_MUNICIPALITIES = [
  'Boac',
  'Buenavista',
  'Gasan',
  'Mogpog',
  'Santa Cruz',
  'Torrijos',
]

// PSA's PSGC publication: one row per geographic unit, with a 10-digit code and a level.
const CODE_HEADERS = ['10-digit psgc', 'psgc', 'code']
const NAME_HEADERS = ['name']
const LEVEL_HEADERS = ['geographic level', 'level']
const LEVEL_PROVINCE = new Set(['prov'])
const LEVEL_MUNICIPALITY = new Set(['mun', 'city'])
const LEVEL_BARANGAY = new Set(['bgy'])

/** Creates the province's municipalities by name, without codes. Returns how many were new. */
export async function seedMunicipalities(): Promise<number> {
  return inTransaction(async (session) => {
    let created = 0
    for (const name of MARINDUQUE_MUNICIPALITIES) {
      const normalizedName = normalizeName(name)
      if (await Municipality.exists({ normalizedName }).session(session)) continue
      await Municipality.create([{ name }], { session })
      created += 1
    }
    return created
  })
}

export interface PsgcRow {
  code: string
  name: string
  level: string
}

export interface PsgcReport {
  municipalitiesCoded: string[]
  municipalitiesMissing: string[]
  barangaysVerified: number
  barangaysCreated: number
  /** Import-created barangays with no PSGC match. They stay unverified, for manual review. */
  barangaysUnmatched: string[]
}

/** 'Boac (Capital)' -> 'Boac'. */
function psgcName(raw: string): string {
  return collapseSpaces(raw.replace(/\s*\(.*?\)\s*/gu, ' '))
}

function columnOf(lowered: string[], headers: string[]): number {
  for (const header of headers) {
    const index = lowered.indexOf(header)
    if (index >= 0) return index
  }
  return -1
}

export function parsePsgcRows(rows: Iterable<string[]>): PsgcRow[] {
  let columns: { code: number; name: number; level: number } | undefined
  const parsed: PsgcRow[] = []
  for (const cells of rows) {
    if (!columns) {
      const lowered = cells.map((cell) => cell.toLowerCase())
      const found = {
        code: columnOf(lowered, CODE_HEADERS),
        name: columnOf(lowered, NAME_HEADERS),
        level: columnOf(lowered, LEVEL_HEADERS),
      }
      if (Math.min(found.code, found.name, found.level) >= 0) columns = found
      continue
    }
    const raw = cells[columns.code] ?? ''
    const code = raw ? (raw.split('.')[0] ?? '').padStart(10, '0') : ''
    if (/[^0]/u.test(code)) {
      parsed.push({
        code,
        name: cells[columns.name] ?? '',
        level: (cells[columns.level] ?? '').toLowerCase(),
      })
    }
  }
  if (!columns) {
    throw new DomainError(
      'psgc_format',
      "PSGC header row not found (expected '10-digit PSGC', 'Name', 'Geographic Level').",
    )
  }
  return parsed
}

/** Reads PSA's PSGC .xlsx, or a .csv export with the same headers. */
export async function readPsgcRows(path: string): Promise<PsgcRow[]> {
  if (extname(path).toLowerCase() === '.csv') {
    const text = await readFile(path, 'utf8')
    return parsePsgcRows(
      parseCsv(text, {
        bom: true,
        relax_column_count: true,
        skip_empty_lines: true,
        trim: true,
      }),
    )
  }
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(path)
  const sheet =
    workbook.worksheets.find((candidate) => candidate.name.toLowerCase().includes('psgc')) ??
    workbook.worksheets[0]
  if (!sheet) throw new DomainError('psgc_format', 'The PSGC workbook has no sheets.')
  const rows: string[][] = []
  sheet.eachRow((row) => {
    rows.push(
      Array.from({ length: row.cellCount }, (_, index) => cellText(row.getCell(index + 1).value)),
    )
  })
  return parsePsgcRows(rows)
}

/** Fills municipality and barangay PSGC codes for one province from the official file. */
export async function loadPsgc(
  path: string,
  { province, dryRun = false }: { province: string; dryRun?: boolean },
): Promise<PsgcReport> {
  const rows = await readPsgcRows(path)
  const target = normalizeName(province)
  const provinceRow = rows.find(
    (row) => LEVEL_PROVINCE.has(row.level) && normalizeName(row.name) === target,
  )
  if (!provinceRow) {
    throw new DomainError('psgc_province', `Province '${province}' not found in the PSGC file.`)
  }
  // A 10-digit PSGC reads RR PPP MM BBB, so the first 5 digits are the province.
  const prefix = provinceRow.code.slice(0, 5)
  const inProvince = rows.filter((row) => row.code.startsWith(prefix) && row !== provinceRow)

  return inTransaction(async (session) => {
    const report: PsgcReport = {
      municipalitiesCoded: [],
      municipalitiesMissing: [],
      barangaysVerified: 0,
      barangaysCreated: 0,
      barangaysUnmatched: [],
    }
    const towns = await Municipality.find().session(session)
    const townByName = new Map(towns.map((town) => [town.normalizedName, town]))
    const townByPrefix = new Map<string, MunicipalityDoc & { _id: string }>()
    for (const row of inProvince.filter((item) => LEVEL_MUNICIPALITY.has(item.level))) {
      const name = psgcName(row.name)
      const town = townByName.get(normalizeName(name))
      if (!town) {
        report.municipalitiesMissing.push(name)
        continue
      }
      town.psgcCode = row.code
      await town.save({ session })
      townByPrefix.set(row.code.slice(0, 7), town)
      report.municipalitiesCoded.push(town.name)
    }

    const barangays = await Barangay.find().session(session)
    const barangayKey = (municipalityId: string, normalizedName: string) =>
      `${municipalityId}|${normalizedName}`
    const barangayByKey = new Map(
      barangays.map((row) => [barangayKey(row.municipalityId, row.normalizedName), row]),
    )
    for (const row of inProvince.filter((item) => LEVEL_BARANGAY.has(item.level))) {
      const town = townByPrefix.get(row.code.slice(0, 7))
      if (!town) continue
      const name = psgcName(row.name)
      const existing = barangayByKey.get(barangayKey(town._id, normalizeName(name)))
      const barangay = existing ?? new Barangay({ municipalityId: town._id, name })
      if (existing) report.barangaysVerified += 1
      else report.barangaysCreated += 1
      barangay.psgcCode = row.code
      barangay.isVerified = true
      await barangay.save({ session })
    }

    const unverified = await Barangay.find({ isVerified: false })
      .session(session)
      .lean<BarangayDoc[]>()
    const townName = new Map(towns.map((town) => [town._id, town.name]))
    report.barangaysUnmatched = unverified.map(
      (row) => `${row.name}, ${townName.get(row.municipalityId) ?? ''}`,
    )
    if (dryRun) await session.abortTransaction()
    return report
  })
}

/** The newest PSGC file in the reference folder, if one has been put there. */
export async function findPsgcFile(referenceDir: string): Promise<string | undefined> {
  const names = await readdir(referenceDir).catch(() => [] as string[])
  const candidates = names
    .filter(
      (name) =>
        name.toLowerCase().includes('psgc') &&
        ['.xlsx', '.csv'].includes(extname(name).toLowerCase()),
    )
    .sort()
  const last = candidates.at(-1)
  return last === undefined ? undefined : join(referenceDir, last)
}
