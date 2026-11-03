/**
 * Reader for workbooks with the layout of the PAO's 2023 inventory (brief §3, §10.A). Titles come
 * first, then a header row ("NAME OF FARMER"...), stage labels in the row below it, data until a TOTAL
 * row with SUM formulas, then stray rows. Everything is found by content, not by fixed row or column
 * numbers, and stages are matched through the catalog, so any crop with this layout can be read.
 *
 * Only reads. The plan decides what to import.
 */
import ExcelJS from 'exceljs'

import { normalizeName } from '../../lib/text.js'
import { cleanText } from './normalizers.js'

const HEADER_SCAN_ROWS = 30
/** Stop reading a sheet after this many empty rows past the total. */
const TRAILING_EMPTY_ROWS = 25

// Header text (normalized, "contains") -> field name. The first match wins.
const HEADER_FIELDS: [string, string][] = [
  ['name of farmer', 'name'],
  ['farm location', 'farm_location'],
  ['barangay', 'barangay'],
  ['association', 'association'],
  ['contact', 'contact'],
  ['variety', 'variety'],
  ['date planted', 'date_planted'],
  ['source', 'source'],
  ['remark', 'remarks'],
]

export type CellData = string | number | boolean | Date | null
type Table = CellData[][]

export type StageResolver = (label: string) => { code: string } | undefined

export interface WorkbookRow {
  sheet: string
  row: number
  values: Record<string, CellData>
  counts: Record<string, CellData>
  belowTotal: boolean
}

export function rowName(row: WorkbookRow): string {
  return cleanText(row.values.name)
}

export interface StageColumnTotal {
  stage: string
  column: string
  /** Such as '=SUM(J13:J48)'. Empty when the cell holds a plain number. */
  formula: string
  /** The value Excel saved with the file, if it was ever calculated. */
  cached: CellData
  evaluated: number | null
  /** The data rows the formula includes. */
  coveredRows: number[]
}

/** What the workbook shows: Excel's saved value, otherwise our evaluation. */
export function workbookValue(total: StageColumnTotal): number | null {
  return typeof total.cached === 'number' ? Math.trunc(total.cached) : total.evaluated
}

export interface WorkbookSheet {
  name: string
  municipality: string
  title: string
  asOf: string
  headerRow: number
  columns: Record<string, number>
  stageColumns: Record<string, number>
  rows: WorkbookRow[]
  totalRow: number | null
  totals: Record<string, StageColumnTotal>
  issues: string[]
}

export interface SummaryRow {
  municipality: string
  farmers: number | null
  area: Record<string, number>
  population: Record<string, number>
}

export interface ParsedWorkbook {
  sheets: WorkbookSheet[]
  /** Normalized municipality -> row. */
  summary: Record<string, SummaryRow>
  summaryIssues: string[]
  unknownSheets: string[]
}

export const aboveTotal = (sheet: WorkbookSheet) => sheet.rows.filter((row) => !row.belowTotal)
export const belowTotal = (sheet: WorkbookSheet) => sheet.rows.filter((row) => row.belowTotal)

// --- Formulas

const SUM = /^=\s*SUM\((?<args>[^()]*)\)\s*$/iu
const REF = /^\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/iu

function columnIndex(letters: string): number {
  return Array.from(letters.toUpperCase()).reduce(
    (total, letter) => total * 26 + letter.charCodeAt(0) - 64,
    0,
  )
}

export function columnLetter(index: number): string {
  let letters = ''
  for (let rest = index; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters
  }
  return letters
}

/** '=SUM(J13:J48)' -> [[col, row, col, row]]. Null when it is not a plain SUM of ranges. */
export function sumRanges(formula: string): [number, number, number, number][] | null {
  const args = SUM.exec(formula)?.groups?.args
  if (args === undefined) return null
  const ranges: [number, number, number, number][] = []
  for (const arg of args.split(',')) {
    const ref = REF.exec(arg.trim())
    if (!ref) return null
    const c1 = columnIndex(ref[1] ?? '')
    const r1 = Number(ref[2])
    const c2 = ref[3] ? columnIndex(ref[3]) : c1
    const r2 = ref[4] ? Number(ref[4]) : r1
    ranges.push([Math.min(c1, c2), Math.min(r1, r2), Math.max(c1, c2), Math.max(r1, r2)])
  }
  return ranges
}

function numeric(value: CellData): number {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean' || value === null || value instanceof Date) return 0
  const parsed = Number(value.replaceAll(',', '').trim())
  return Number.isFinite(parsed) ? parsed : 0 // Excel's SUM ignores text
}

// --- Reading

function plainValue(value: ExcelJS.CellValue): CellData {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value
  if (typeof value !== 'object') return value
  if ('richText' in value) return value.richText.map((part) => part.text).join('')
  if ('error' in value) return value.error
  if ('formula' in value || 'sharedFormula' in value) return plainValue(value.result)
  if ('text' in value) return typeof value.text === 'string' ? value.text : plainValue(value.text)
  return null
}

/** Each sheet twice: as saved values, and with formulas as text. */
export async function readTables(
  content: Buffer,
): Promise<Map<string, { values: Table; formulas: Table }>> {
  const workbook = new ExcelJS.Workbook()
  // ExcelJS declares its own Buffer type, which differs from Node's only in name.
  await workbook.xlsx.load(content as unknown as ArrayBuffer)
  const tables = new Map<string, { values: Table; formulas: Table }>()
  for (const sheet of workbook.worksheets) {
    const values: Table = []
    const formulas: Table = []
    for (let r = 1; r <= sheet.rowCount; r += 1) {
      const row = sheet.getRow(r)
      const valueRow: CellData[] = []
      const formulaRow: CellData[] = []
      for (let c = 1; c <= row.cellCount; c += 1) {
        const cell = row.getCell(c)
        // A merged cell repeats its first cell's value, but only the first cell really holds it.
        const merged = cell.type === ExcelJS.ValueType.Merge
        const saved = merged ? null : plainValue(cell.value)
        valueRow.push(saved)
        const formula = merged ? undefined : (cell.formula as string | undefined)
        formulaRow.push(formula ? `=${formula}` : saved)
      }
      values.push(valueRow)
      formulas.push(formulaRow)
    }
    tables.set(sheet.name, { values, formulas })
  }
  return tables
}

function cellAt(table: Table, row: number, column: number): CellData {
  return table[row - 1]?.[column - 1] ?? null
}

function findHeader(table: Table): number | null {
  for (let r = 1; r <= Math.min(table.length, HEADER_SCAN_ROWS); r += 1) {
    if (table[r - 1]?.some((cell) => normalizeName(cleanText(cell)).includes('name of farmer'))) {
      return r
    }
  }
  return null
}

function mapColumns(header: CellData[]): Record<string, number> {
  const columns: Record<string, number> = {}
  header.forEach((cell, index) => {
    const text = normalizeName(cleanText(cell))
    if (!text) return
    if (['no', 'number'].includes(text) && columns.no === undefined) {
      columns.no = index + 1
      return
    }
    for (const [needle, name] of HEADER_FIELDS) {
      if (text.includes(needle) && columns[name] === undefined) {
        columns[name] = index + 1
        break
      }
    }
  })
  return columns
}

function mapStages(table: Table, headerRow: number, resolve: StageResolver) {
  const stages: Record<string, number> = {}
  for (const r of [headerRow + 1, headerRow]) {
    table[r - 1]?.forEach((cell, index) => {
      const label = cleanText(cell)
      const stage = label ? resolve(label) : undefined
      if (stage && stages[stage.code] === undefined) stages[stage.code] = index + 1
    })
  }
  return stages
}

function isTotalRow(
  values: CellData[],
  formulas: CellData[],
  stageColumns: Record<string, number>,
  labelColumns: number,
): boolean {
  if (values.slice(0, labelColumns).some((v) => normalizeName(cleanText(v)).startsWith('total'))) {
    return true
  }
  return Object.values(stageColumns).some((column) => {
    const formula = formulas[column - 1]
    return typeof formula === 'string' && formula.trimStart().toUpperCase().startsWith('=SUM')
  })
}

function isEmptyRow(row: WorkbookRow): boolean {
  return ![...Object.values(row.values), ...Object.values(row.counts)].some(cleanText)
}

function readTotals(sheet: WorkbookSheet, values: Table, formulas: Table) {
  const totals: Record<string, StageColumnTotal> = {}
  const totalRow = sheet.totalRow as number
  for (const [stage, column] of Object.entries(sheet.stageColumns)) {
    const formulaCell = cellAt(formulas, totalRow, column)
    const formula =
      typeof formulaCell === 'string' && formulaCell.startsWith('=') ? formulaCell : ''
    let evaluated: number | null = null
    const covered = new Set<number>()
    if (formula) {
      const ranges = sumRanges(formula)
      if (ranges === null) {
        sheet.issues.push(
          `${columnLetter(column)}${String(totalRow)}: unsupported formula ${formula}`,
        )
      } else {
        let total = 0
        for (const [c1, r1, c2, r2] of ranges) {
          for (let r = r1; r <= r2; r += 1) {
            for (let c = c1; c <= c2; c += 1) {
              total += numeric(cellAt(values, r, c))
              if (c === column) covered.add(r)
            }
          }
        }
        evaluated = Math.round(total)
      }
    } else if (typeof formulaCell === 'number') {
      evaluated = Math.trunc(formulaCell) // a typed-in number instead of a formula
    }
    totals[stage] = {
      stage,
      column: columnLetter(column),
      formula,
      cached: cellAt(values, totalRow, column),
      evaluated,
      coveredRows: [...covered].sort((a, b) => a - b),
    }
  }
  return totals
}

export function readSheet(
  title: string,
  municipality: string,
  values: Table,
  formulas: Table,
  resolve: StageResolver,
): WorkbookSheet {
  const sheet: WorkbookSheet = {
    name: title,
    municipality,
    title: '',
    asOf: '',
    headerRow: 0,
    columns: {},
    stageColumns: {},
    rows: [],
    totalRow: null,
    totals: {},
    issues: [],
  }
  const header = findHeader(formulas)
  if (header === null) {
    sheet.issues.push("Header row with 'NAME OF FARMER' not found; sheet skipped.")
    return sheet
  }
  sheet.headerRow = header
  for (let r = 1; r < header; r += 1) {
    const text = (values[r - 1] ?? []).map(cleanText).filter(Boolean).join(' ')
    const lower = text.toLowerCase()
    if (lower.includes('population data') || lower.includes('municipality of')) sheet.title = text
    else if (lower.startsWith('as of')) sheet.asOf = text
  }
  sheet.columns = mapColumns(formulas[header - 1] ?? [])
  sheet.stageColumns = mapStages(formulas, header, resolve)
  const missing = ['name', 'barangay'].filter((field) => sheet.columns[field] === undefined)
  const stageColumnList = Object.values(sheet.stageColumns)
  if (missing.length > 0 || stageColumnList.length === 0) {
    sheet.issues.push(`Missing columns: ${missing.join(', ') || 'stage counts'}; sheet skipped.`)
    return sheet
  }

  const labelColumns = Math.min(...stageColumnList) - 1
  const subHeaderHasValues = stageColumnList.some((c) => Boolean(cellAt(formulas, header + 1, c)))
  const firstData = subHeaderHasValues ? header + 2 : header + 1
  let emptyRun = 0
  for (let r = firstData; r <= values.length; r += 1) {
    const rowValues = values[r - 1] ?? []
    const rowFormulas = formulas[r - 1] ?? []
    if (
      sheet.totalRow === null &&
      isTotalRow(rowValues, rowFormulas, sheet.stageColumns, labelColumns)
    ) {
      sheet.totalRow = r
      continue
    }
    const pick = (columns: Record<string, number>) =>
      Object.fromEntries(Object.entries(columns).map(([key, c]) => [key, cellAt(values, r, c)]))
    const row: WorkbookRow = {
      sheet: title,
      row: r,
      values: pick(sheet.columns),
      counts: pick(sheet.stageColumns),
      belowTotal: sheet.totalRow !== null,
    }
    if (isEmptyRow(row)) {
      emptyRun += 1
      if (sheet.totalRow !== null && emptyRun >= TRAILING_EMPTY_ROWS) break
      continue
    }
    emptyRun = 0
    sheet.rows.push(row)
  }

  if (sheet.totalRow === null) sheet.issues.push('No TOTAL row found; all rows treated as data.')
  else sheet.totals = readTotals(sheet, values, formulas)
  return sheet
}

/**
 * The SUMMARY sheet: per municipality, the number of farmers, area by stage and population by stage.
 * Stage labels appear twice (area block, population block). A block is "area" when the text above it
 * mentions area or hectares, otherwise "population". With no hints, the first block is area.
 */
export function readSummary(
  rows: Table,
  municipalities: string[],
  resolve: StageResolver,
): { summary: Record<string, SummaryRow>; issues: string[] } {
  const wanted = new Map(municipalities.map((name) => [normalizeName(name), name]))
  const labelIndex = rows.slice(0, HEADER_SCAN_ROWS).findIndex((cells) => {
    return cells.filter((cell) => cleanText(cell) && resolve(cleanText(cell))).length >= 2
  })
  if (labelIndex < 0) {
    return { summary: {}, issues: ['SUMMARY: stage label row not found; summary not reconciled.'] }
  }
  const labelRow = labelIndex + 1

  const blocks: Record<string, number>[] = []
  rows[labelIndex]?.forEach((cell, index) => {
    const label = cleanText(cell)
    const stage = label ? resolve(label) : undefined
    if (!stage) return
    const last = blocks.at(-1)
    if (!last || last[stage.code] !== undefined) blocks.push({})
    ;(blocks.at(-1) as Record<string, number>)[stage.code] = index + 1
  })

  const hint = (block: Record<string, number>): string => {
    const first = Math.min(...Object.values(block))
    const parts: string[] = []
    for (let r = Math.max(1, labelRow - 3); r < labelRow; r += 1) {
      for (let c = Math.max(1, first - 1); c < first + 4; c += 1) {
        parts.push(normalizeName(cleanText(cellAt(rows, r, c))))
      }
    }
    const text = parts.join(' ')
    if (text.includes('area') || ` ${text}`.includes(' ha') || text.includes('hectare')) {
      return 'area'
    }
    if (text.includes('population') || text.includes('trees') || text.includes('no of')) {
      return 'population'
    }
    return ''
  }
  let kinds = blocks.map(hint)
  if (blocks.length >= 2 && !kinds.some(Boolean)) {
    kinds[0] = 'area'
    kinds[1] = 'population'
  }
  if (!kinds.includes('population')) {
    kinds = kinds.map((kind) => (kind === 'area' ? 'area' : 'population'))
  }

  let farmersColumn: number | null = null
  for (const r of [labelRow, labelRow - 1]) {
    if (farmersColumn !== null || r < 1) continue
    const found =
      rows[r - 1]?.findIndex((v) => normalizeName(cleanText(v)).includes('farmer')) ?? -1
    if (found >= 0) farmersColumn = found + 1
  }

  const summary: Record<string, SummaryRow> = {}
  for (let r = labelRow + 1; r <= rows.length; r += 1) {
    const cells = rows[r - 1] ?? []
    const label = cleanText(cells.find((v) => typeof v === 'string' && cleanText(v)))
    // Rows are labelled "BOAC, MARINDUQUE" in the real file, so the province suffix is dropped.
    const key = normalizeName(label).replace(/\s+marinduque$/u, '')
    const municipality = wanted.get(key)
    if (municipality === undefined) continue
    const area: Record<string, number> = {}
    const population: Record<string, number> = {}
    blocks.forEach((block, index) => {
      for (const [stage, column] of Object.entries(block)) {
        const value = cellAt(rows, r, column)
        if (typeof value !== 'number') continue
        if (kinds[index] === 'area') area[stage] = value
        else population[stage] = Math.round(value)
      }
    })
    const farmers = farmersColumn === null ? null : cellAt(rows, r, farmersColumn)
    summary[key] = {
      municipality,
      farmers: typeof farmers === 'number' ? Math.trunc(farmers) : null,
      area,
      population,
    }
  }
  const missing = [...wanted].filter(([key]) => summary[key] === undefined).map(([, name]) => name)
  return {
    summary,
    issues: missing.length > 0 ? [`SUMMARY: no row for ${missing.join(', ')}.`] : [],
  }
}

export async function readWorkbook(
  content: Buffer,
  municipalities: string[],
  resolve: StageResolver,
): Promise<ParsedWorkbook> {
  const tables = await readTables(content)
  const byName = new Map(municipalities.map((name) => [normalizeName(name), name]))
  const parsed: ParsedWorkbook = { sheets: [], summary: {}, summaryIssues: [], unknownSheets: [] }
  for (const [title, { values, formulas }] of tables) {
    const key = normalizeName(title)
    const municipality = byName.get(key)
    if (municipality !== undefined) {
      parsed.sheets.push(readSheet(title, municipality, values, formulas, resolve))
    } else if (key === 'summary') {
      const { summary, issues } = readSummary(values, municipalities, resolve)
      parsed.summary = summary
      parsed.summaryIssues = issues
    } else {
      parsed.unknownSheets.push(title)
    }
  }
  return parsed
}
