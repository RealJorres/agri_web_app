/**
 * The clean ongoing import template (brief §10.B): one row per crop stand. It is generated from the
 * catalog and locations, with dropdowns, and rows are imported through the regular services, so every
 * scope check, rule and audit entry applies. Each row commits on its own (ADR-0020).
 */
import { parse as parseCsv } from 'csv-parse/sync'
import ExcelJS from 'exceljs'

import { DomainError } from '../../lib/errors.js'
import { readPrivateFile } from '../../lib/privateFiles.js'
import { Cap } from '../../lib/roles.js'
import { scopeFilter, within, type Actor, type Scope } from '../../lib/scoping.js'
import { normalizeName, normalizePersonName } from '../../lib/text.js'
import { inTransaction } from '../../lib/transaction.js'
import { User } from '../../models/account.models.js'
import {
  type CommodityDoc,
  GrowthStage,
  type GrowthStageDoc,
  MaterialSource,
  Variety,
  type MaterialSourceDoc,
  type VarietyDoc,
} from '../../models/catalog.models.js'
import { CropStand, type CropStandDoc, Farm, type FarmDoc } from '../../models/farm.models.js'
import { ImportRowLink, type ImportJobDoc } from '../../models/import.models.js'
import { Barangay, Municipality, type BarangayDoc } from '../../models/location.models.js'
import {
  Association,
  type AssociationDoc,
  AssociationMember,
  Farmer,
  FARMER_SCOPE,
  type FarmerDoc,
} from '../../models/registry.models.js'
import { InventoryRecord } from '../../models/survey.models.js'
import { getScope } from '../../selectors/accounts.selectors.js'
import { sourceIndex, varietyIndex } from '../../selectors/catalog.selectors.js'
import { createCropStand, createFarm, createPlanting } from '../farm.service.js'
import { addMember, createAssociation, createFarmer } from '../registry.service.js'
import { createRecord, submit } from '../survey.service.js'
import {
  cleanText,
  mapTokens,
  parseAssociations,
  parseContact,
  parseCount,
  parseYears,
  splitValues,
} from './normalizers.js'
import { columnLetter, readTables, type CellData } from './workbookReader.js'

export const SHEET = 'Records'
export const LISTS = 'Lists'
const PRIVACY_NOTICE =
  'PRIVACY NOTICE (RA 10173): Personal data collected here is used by the Provincial Agriculture ' +
  "Office of Marinduque only to manage agricultural programs. Record 'Y' in the Consent column " +
  'only after the farmer has been informed and agreed.'

export interface Column {
  key: string
  header: string
  required?: boolean
  width?: number
}

const BASE_COLUMNS: Column[] = [
  { key: 'municipality', header: 'Municipality', required: true },
  { key: 'barangay', header: 'Home barangay', required: true, width: 28 },
  { key: 'first_name', header: 'First name', required: true },
  { key: 'middle_name', header: 'Middle name' },
  { key: 'last_name', header: 'Last name', required: true },
  { key: 'suffix', header: 'Suffix', width: 8 },
  { key: 'sex', header: 'Sex', width: 10 },
  { key: 'birth_year', header: 'Birth year', width: 10 },
  { key: 'rsbsa_no', header: 'RSBSA no.' },
  { key: 'contact_no', header: 'Contact no.' },
  { key: 'consent', header: 'Consent (Y/N)', required: true, width: 12 },
  { key: 'associations', header: 'Association(s)', width: 28 },
  { key: 'farm_barangay', header: 'Farm barangay (if different)', width: 28 },
  { key: 'sitio', header: 'Sitio' },
  { key: 'varieties', header: 'Variety(ies)', width: 18 },
  { key: 'years', header: 'Year(s) planted', width: 16 },
  { key: 'source', header: 'Source of planting materials', width: 24 },
]
const END_COLUMNS: Column[] = [{ key: 'remarks', header: 'Remarks', width: 32 }]

async function stagesOf(commodityId: string): Promise<GrowthStageDoc[]> {
  return GrowthStage.find({ commodityId }).sort({ sortOrder: 1 }).lean<GrowthStageDoc[]>()
}

export async function columnsFor(commodity: CommodityDoc): Promise<Column[]> {
  const stages = await stagesOf(commodity._id)
  return [
    ...BASE_COLUMNS,
    ...stages.map((stage) => ({ key: `stage:${stage.code}`, header: stage.label, width: 12 })),
    ...END_COLUMNS,
  ]
}

/** Builds the template workbook, with dropdowns from the catalog. */
export async function generateTemplate(commodity: CommodityDoc): Promise<Buffer> {
  const columns = await columnsFor(commodity)
  const collator = new Intl.Collator('en')
  const [towns, barangays, varieties, sources] = await Promise.all([
    Municipality.find().lean(),
    Barangay.find().lean<BarangayDoc[]>(),
    Variety.find({ commodityId: commodity._id }).lean<VarietyDoc[]>(),
    MaterialSource.find().lean<MaterialSourceDoc[]>(),
  ])
  const townName = new Map(towns.map((town) => [town._id, town.name]))
  const barangayLabels = barangays
    .map((row) => ({ town: townName.get(row.municipalityId) ?? '', name: row.name }))
    .sort((a, b) => collator.compare(a.town, b.town) || collator.compare(a.name, b.name))
    .map(({ town, name }) => `${name} (${town})`)

  const workbook = new ExcelJS.Workbook()
  const help = workbook.addWorksheet('Instructions')
  const sheet = workbook.addWorksheet(SHEET, { views: [{ state: 'frozen', ySplit: 1 }] })
  const lists = workbook.addWorksheet(LISTS, { state: 'hidden' })
  workbook.views = [
    { x: 0, y: 0, width: 10000, height: 20000, firstSheet: 0, activeTab: 1, visibility: 'visible' },
  ]

  columns.forEach((column, index) => {
    const cell = sheet.getCell(1, index + 1)
    cell.value = column.header + (column.required ? ' *' : '')
    cell.font = { bold: true }
    if (column.required) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF4CC' } }
    }
    sheet.getColumn(index + 1).width = column.width ?? 16
  })

  const values: [string, string[]][] = [
    ['municipality', towns.map((town) => town.name).sort((a, b) => collator.compare(a, b))],
    ['barangay', barangayLabels],
    ['varieties', varieties.map((row) => row.code).sort()],
    ['source', sources.map((row) => row.name).sort((a, b) => collator.compare(a, b))],
    ['sex', ['Male', 'Female']],
    ['consent', ['Y', 'N']],
    ['farm_barangay', barangayLabels],
  ]
  const keys = columns.map((column) => column.key)
  values.forEach(([key, items], listIndex) => {
    const letter = columnLetter(listIndex + 1)
    lists.getCell(1, listIndex + 1).value = key
    items.forEach((item, row) => {
      lists.getCell(row + 2, listIndex + 1).value = item
    })
    const position = keys.indexOf(key)
    if (items.length === 0 || position < 0) return
    const target = columnLetter(position + 1)
    // The library's type definitions leave this property out, though it is there at runtime.
    const { dataValidations } = sheet as unknown as {
      dataValidations: { add: (range: string, rule: object) => void }
    }
    dataValidations.add(`${target}2:${target}5000`, {
      type: 'list',
      formulae: [`=${LISTS}!$${letter}$2:$${letter}$${String(items.length + 1)}`],
      allowBlank: true,
      // Varieties may hold several codes ("BR25, UF18"), so this warns instead of blocking.
      errorStyle: key === 'varieties' ? 'warning' : 'stop',
      showErrorMessage: true,
    })
  })

  const lines = [
    `${commodity.name} inventory template - one row per farmer farm (crop stand).`,
    'Columns marked * are required. Use the dropdowns; several varieties or years may be ' +
      'separated with commas.',
    'Stage columns hold tree counts (whole numbers, 0 or more). Leave blank if unknown.',
    '',
    PRIVACY_NOTICE,
    '',
    `Generated ${new Date().toISOString().slice(0, 10)}. Do not rename the column headers.`,
  ]
  lines.forEach((line, index) => {
    help.getCell(index + 1, 1).value = line
  })
  help.getColumn(1).width = 120
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

// --- Reading and validating

export interface TemplateRow {
  row: number
  raw: Record<string, CellData>
  errors: string[]
  clean?: CleanRow
}

interface CleanRow {
  municipalityId: string | null
  municipalityName: string | null
  homeId: string | null
  farmBarangayId: string | null
  farmer: {
    firstName: string
    middleName: string
    lastName: string
    suffix: string
    sex: '' | 'male' | 'female'
    birthYear: number | null
    rsbsaNo: string | null
    contactNo: string
    homeBarangay: string | undefined
  }
  existingFarmerId: string | null
  associations: string[]
  sitio: string
  varietyIds: string[]
  sourceId: string | null
  years: number[]
  counts: Record<string, number | null>
  remarks: string
}

async function readTable(job: ImportJobDoc): Promise<CellData[][]> {
  const content = await readPrivateFile(job.filePath)
  if (job.originalName.toLowerCase().endsWith('.csv')) {
    return parseCsv(content, { bom: true, relax_column_count: true, skip_empty_lines: false })
  }
  const tables = await readTables(content)
  const table = tables.get(SHEET) ?? [...tables.values()][0]
  return table?.values ?? []
}

async function readRows(job: ImportJobDoc, commodity: CommodityDoc): Promise<TemplateRow[]> {
  const columns = await columnsFor(commodity)
  const table = await readTable(job)
  const [header, ...body] = table
  if (!header) return []
  const byHeader = new Map(columns.map((column) => [normalizeName(column.header), column.key]))
  const headerKeys = header.map((cell) => {
    return byHeader.get(normalizeName(cleanText(cell).replace(/[ *]+$/u, '')))
  })
  const missing = columns
    .filter((c) => c.required && !headerKeys.includes(c.key))
    .map((c) => c.header)
  if (missing.length > 0) {
    throw new DomainError(
      'template_headers',
      `This file does not match the template. Missing columns: ${missing.join(', ')}`,
    )
  }
  const rows: TemplateRow[] = []
  body.forEach((cells, index) => {
    const raw: Record<string, CellData> = {}
    headerKeys.forEach((key, column) => {
      if (key) raw[key] = cells[column] ?? null
    })
    if (Object.values(raw).some(cleanText)) rows.push({ row: index + 2, raw, errors: [] })
  })
  return rows
}

async function validateRows(
  rows: TemplateRow[],
  job: ImportJobDoc,
  commodity: CommodityDoc,
  scope: Scope,
): Promise<void> {
  const [towns, barangays, stages, varieties, sources] = await Promise.all([
    Municipality.find().lean(),
    Barangay.find().lean<BarangayDoc[]>(),
    stagesOf(commodity._id),
    varietyIndex(commodity._id),
    sourceIndex(),
  ])
  const townByName = new Map(towns.map((town) => [town.normalizedName, town]))
  const barangayByKey = new Map(
    barangays.map((row) => [`${row.municipalityId}|${row.normalizedName}`, row]),
  )
  const findBarangay = (text: unknown, town: (typeof towns)[number] | undefined) => {
    let name = cleanText(text)
    if (!town || !name) return undefined
    const suffix = `(${town.name})`
    if (name.toLowerCase().endsWith(suffix.toLowerCase())) {
      name = name.slice(0, -suffix.length).trim()
    }
    return barangayByKey.get(`${town._id}|${normalizeName(name)}`)
  }
  const visible = scopeFilter(scope, Cap.VIEW_RECORDS, FARMER_SCOPE)
  const seen = new Map<string, number>()

  for (const row of rows) {
    const { raw: v, errors: e } = row
    const town = townByName.get(normalizeName(cleanText(v.municipality)))
    if (!town) e.push('Municipality not recognised.')
    const home = findBarangay(v.barangay, town)
    if (town && !home) e.push('Home barangay not found in that municipality.')
    const hasFarmBarangay = Boolean(cleanText(v.farm_barangay))
    const farmBarangay = hasFarmBarangay ? findBarangay(v.farm_barangay, town) : home
    if (hasFarmBarangay && !farmBarangay) e.push('Farm barangay not found in that municipality.')
    const first = cleanText(v.first_name)
    const last = cleanText(v.last_name)
    if (!first && !last) e.push('First or last name is required.')
    const sexes: Record<string, '' | 'male' | 'female'> = {
      male: 'male',
      m: 'male',
      female: 'female',
      f: 'female',
      '': '',
    }
    const sex = sexes[normalizeName(cleanText(v.sex))]
    if (sex === undefined) e.push('Sex must be Male or Female.')
    const birth = parseCount(v.birth_year)
    const thisYear = new Date().getUTCFullYear()
    if (birth.issue || (birth.value !== null && (birth.value < 1900 || birth.value > thisYear))) {
      e.push('Birth year must be a 4-digit year.')
    }
    if (!['y', 'yes'].includes(normalizeName(cleanText(v.consent)))) {
      e.push("Consent must be 'Y' (show the privacy notice first).")
    }
    const rsbsa = cleanText(v.rsbsa_no).toUpperCase() || null

    const mappedVarieties = mapTokens(splitValues(v.varieties), (token) => varieties.resolve(token))
    if (mappedVarieties.unknown.length > 0) {
      e.push(`Unknown variety: ${mappedVarieties.unknown.join(', ')}.`)
    }
    const mappedSources = mapTokens(splitValues(v.source), (token) => sources.resolve(token))
    if (mappedSources.unknown.length > 0) {
      e.push(`Unknown source: ${mappedSources.unknown.join(', ')}.`)
    }
    if (mappedSources.found.length > 1) e.push('Choose one source per row.')
    const years = parseYears(v.years)
    if (years.issue) e.push(`Year(s) planted: ${years.issue}.`)

    const counts: Record<string, number | null> = {}
    for (const stage of stages) {
      const parsed = parseCount(v[`stage:${stage.code}`])
      if (parsed.issue) e.push(`${stage.label}: ${parsed.issue}.`)
      counts[stage.code] = parsed.value
    }
    const remarks = cleanText(v.remarks)
    if (!Object.values(counts).some(Boolean) && !remarks) {
      e.push('Enter at least one stage count, or explain in Remarks.')
    }

    const identity = rsbsa ?? `${home?._id ?? ''}|${normalizePersonName(`${first} ${last}`)}`
    const earlier = seen.get(identity)
    if (earlier !== undefined) e.push(`Same farmer as row ${String(earlier)} (one row per farm).`)
    else seen.set(identity, row.row)

    const existing = rsbsa
      ? await Farmer.findOne(within(visible, { rsbsaNo: rsbsa })).lean<FarmerDoc>()
      : null
    row.clean = {
      municipalityId: town?._id ?? null,
      municipalityName: town?.name ?? null,
      homeId: home?._id ?? null,
      farmBarangayId: farmBarangay?._id ?? null,
      farmer: {
        firstName: first,
        middleName: cleanText(v.middle_name),
        lastName: last,
        suffix: cleanText(v.suffix),
        sex: sex ?? '',
        birthYear: birth.value,
        rsbsaNo: rsbsa,
        contactNo: parseContact(v.contact_no),
        homeBarangay: home?._id,
      },
      existingFarmerId: existing?._id ?? null,
      associations: parseAssociations(v.associations),
      sitio: cleanText(v.sitio),
      varietyIds: mappedVarieties.found.map((item) => item._id),
      sourceId: mappedSources.found.length === 1 ? (mappedSources.found[0]?._id ?? null) : null,
      years: years.years,
      counts,
      remarks,
    }
    if (existing && job.surveyRoundId && farmBarangay) {
      const stand = await findStand(existing._id, farmBarangay._id, commodity._id)
      if (
        stand &&
        (await InventoryRecord.exists({ surveyRoundId: job.surveyRoundId, cropStandId: stand._id }))
      ) {
        e.push('This farm already has a record in the selected round.')
      }
    }
  }
}

async function findStand(
  farmerId: string,
  barangayId: string,
  commodityId: string,
): Promise<CropStandDoc | null> {
  const farms = await Farm.find({ farmerId, barangayId }).select('_id').lean<FarmDoc[]>()
  return CropStand.findOne({
    farmId: { $in: farms.map((farm) => farm._id) },
    commodityId,
  }).lean<CropStandDoc>()
}

async function errorReport(rows: TemplateRow[], commodity: CommodityDoc): Promise<Buffer | null> {
  const bad = rows.filter((row) => row.errors.length > 0)
  if (bad.length === 0) return null
  const columns = await columnsFor(commodity)
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Errors')
  sheet.addRow(['Row', ...columns.map((column) => column.header), 'Errors'])
  for (const row of bad) {
    sheet.addRow([
      row.row,
      ...columns.map((column) => cleanText(row.raw[column.key])),
      row.errors.join(' | '),
    ])
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

export async function previewTemplate(job: ImportJobDoc, commodity: CommodityDoc) {
  const uploader = await uploaderScope(job)
  const rows = await readRows(job, commodity)
  await validateRows(rows, job, commodity, uploader)
  const errors = rows
    .filter((row) => row.errors.length > 0)
    .map((row) => ({ sheet: SHEET, row: row.row, messages: row.errors }))
  const names = rows.flatMap((row) => row.clean?.municipalityName ?? [])
  const summary: Record<string, unknown> = {
    municipalities: [...new Set(names)].sort(),
    counts: {
      rows: rows.length,
      valid_rows: rows.filter((row) => row.errors.length === 0).length,
      rows_with_errors: errors.length,
      existing_farmers: rows.filter((row) => row.clean?.existingFarmerId).length,
    },
    errors,
    review: [],
    decisions: {},
    reconciliation: null,
    sheet_issues: [],
  }
  return { summary, report: await errorReport(rows, commodity) }
}

async function uploaderScope(job: ImportJobDoc): Promise<Scope> {
  const user = await User.findOne({ _id: job.uploadedById }).lean()
  if (!user) throw new DomainError('forbidden', 'The uploader no longer exists.', {}, 403)
  return getScope(user)
}

async function commitRow(
  row: TemplateRow,
  job: ImportJobDoc,
  commodity: CommodityDoc,
  stages: GrowthStageDoc[],
  actor: Actor,
): Promise<{ farmerCreated: boolean }> {
  const clean = row.clean as CleanRow
  const roundId = job.surveyRoundId as string
  const farmBarangayId = clean.farmBarangayId as string
  const municipalityId = clean.municipalityId as string
  return inTransaction(async (session) => {
    let farmerId = clean.existingFarmerId
    const farmerCreated = farmerId === null
    if (farmerId === null) {
      const farmer = await createFarmer({ actor, data: clean.farmer, consentGiven: true })
      farmerId = farmer._id
    }
    for (const name of clean.associations) {
      const association =
        (await Association.findOne({
          municipalityId,
          normalizedName: normalizeName(name),
        })
          .session(session)
          .lean<AssociationDoc>()) ??
        (await createAssociation({ actor, data: { name, municipality: municipalityId } }))
      const already = await AssociationMember.exists({
        farmerId,
        associationId: association._id,
      }).session(session)
      if (!already) await addMember({ actor, associationId: association._id, farmerId })
    }
    const farms = await Farm.find({ farmerId, barangayId: farmBarangayId })
      .session(session)
      .select('_id')
      .lean<FarmDoc[]>()
    let stand = await CropStand.findOne({
      farmId: { $in: farms.map((farm) => farm._id) },
      commodityId: commodity._id,
    })
      .session(session)
      .lean<CropStandDoc>()
    if (!stand) {
      const farm = await createFarm({
        actor,
        farmerId,
        data: { barangay: farmBarangayId, sitio: clean.sitio },
      })
      stand = await createCropStand({
        actor,
        farmId: farm._id,
        commodityId: commodity._id,
        data: {},
      })
    }
    const hasPlantingDetails = clean.varietyIds.length > 0 || clean.sourceId !== null
    const years: (number | null)[] =
      clean.years.length > 0 ? clean.years : hasPlantingDetails ? [null] : []
    for (const year of years) {
      await createPlanting({
        actor,
        standId: stand._id,
        data: { yearPlanted: year, source: clean.sourceId },
        varietyIds: clean.varietyIds,
      })
    }
    const stageByCode = new Map(stages.map((stage) => [stage.code, stage]))
    const record = await createRecord({
      actor,
      roundId,
      standId: stand._id,
      counts: Object.entries(clean.counts).flatMap(([code, count]) => {
        const stage = stageByCode.get(code)
        return count !== null && stage ? [{ growthStageId: stage._id, count }] : []
      }),
      remarks: clean.remarks,
    })
    await submit({ actor, recordId: record._id })
    await ImportRowLink.create(
      [
        {
          fileSha256: job.fileSha256,
          sheet: SHEET,
          row: row.row,
          jobId: job._id,
          farmerId,
          farmId: stand.farmId,
          cropStandId: stand._id,
          recordId: record._id,
        },
      ],
      { session },
    )
    return { farmerCreated }
  })
}

/** Loads every valid row. Rows with errors are skipped: see the error report. */
export async function commitTemplate(
  job: ImportJobDoc,
  commodity: CommodityDoc,
  actor: Actor,
): Promise<Record<string, unknown>> {
  const rows = await readRows(job, commodity)
  await validateRows(rows, job, commodity, actor.scope)
  const [stages, links] = await Promise.all([
    stagesOf(commodity._id),
    ImportRowLink.find({ fileSha256: job.fileSha256 }).select('row').lean(),
  ])
  const linked = new Set(links.map((link) => link.row))
  const tally = {
    records_submitted: 0,
    farmers_created: 0,
    rows_skipped_errors: 0,
    rows_already_imported: 0,
    rows_refused: 0,
  }
  const refused: { row: number; message: string }[] = []
  for (const row of rows) {
    if (row.errors.length > 0) {
      tally.rows_skipped_errors += 1
      continue
    }
    if (linked.has(row.row)) {
      tally.rows_already_imported += 1
      continue
    }
    try {
      const { farmerCreated } = await commitRow(row, job, commodity, stages, actor)
      tally.records_submitted += 1
      if (farmerCreated) tally.farmers_created += 1
    } catch (error) {
      // A rule refused this row, and the others can still go in. Anything else stops the import.
      if (!(error instanceof DomainError)) throw error
      tally.rows_refused += 1
      refused.push({ row: row.row, message: error.message })
    }
  }
  return { ...tally, refused }
}
