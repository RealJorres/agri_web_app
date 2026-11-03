/**
 * Turns a read workbook into an import plan and reconciliation. Reads the database (catalog, barangays,
 * associations) but never writes: the same plan drives the preview and the commit.
 */
import { HalfUp } from '../../lib/decimal.js'
import { tokenSortRatio } from '../../lib/fuzzy.js'
import { normalizeName, normalizePersonName } from '../../lib/text.js'
import type {
  CommodityDoc,
  GrowthStageDoc,
  MaterialSourceDoc,
  VarietyDoc,
} from '../../models/catalog.models.js'
import { GrowthStage } from '../../models/catalog.models.js'
import { Barangay, Municipality, type BarangayDoc } from '../../models/location.models.js'
import { Association, type AssociationDoc } from '../../models/registry.models.js'
import { plantsPerHa, sourceIndex, varietyIndex } from '../../selectors/catalog.selectors.js'
import {
  cleanBarangay,
  cleanText,
  mapTokens,
  parseAssociations,
  parseContact,
  parseCount,
  parsePersonName,
  parseRemarks,
  parseYears,
  splitSites,
  splitValues,
  type HarvestInfo,
  type NameParts,
} from './normalizers.js'
import {
  aboveTotal,
  rowName,
  workbookValue,
  type ParsedWorkbook,
  type WorkbookRow,
  type WorkbookSheet,
} from './workbookReader.js'

const ASSOCIATION_AUTO = 90
const ASSOCIATION_REVIEW = 75
/** For rows with no BARANGAY and no FARM LOCATION: unverified, and never a PSGC code. */
export const UNRECORDED_BARANGAY = '(Barangay not recorded)'

export interface AssociationChoice {
  raw: string
  /** The name the membership will use. */
  canonical: string
  existingId: string | null
  score: number
  decision: 'existing' | 'same_as_file' | 'new' | 'review'
}

export interface PlannedRow {
  sheet: string
  row: number
  municipality: string
  /** Below the TOTAL row: becomes a draft, and the farmer needs review. */
  incomplete: boolean
  fullNameRaw: string
  name: NameParts
  homeBarangay: string
  farmBarangay: string
  locationRaw: string
  contact: string
  associations: AssociationChoice[]
  varieties: VarietyDoc[]
  sources: MaterialSourceDoc[]
  years: number[]
  counts: Record<string, number | null>
  harvests: HarvestInfo[]
  remarks: string
  rawVariety: string
  rawSource: string
  rawDate: string
  missing: string[]
  issues: string[]
}

export function rowIdentity(row: PlannedRow): string {
  return [
    row.municipality,
    normalizeName(row.homeBarangay),
    normalizePersonName(row.fullNameRaw),
  ].join('|')
}

export interface ReviewItem {
  sheet: string
  row: number
  kind: string
  message: string
  value: string
}

export interface WorkbookPlan {
  rows: PlannedRow[]
  review: ReviewItem[]
  decisions: Record<string, Record<string, unknown>[]>
  counts: Record<string, number>
  reconciliation: Reconciliation
  sheetIssues: string[]
}

class Tally {
  private readonly counts = new Map<string, { first: string; second: string; rows: number }>()

  add(first: string, second: string): void {
    const key = JSON.stringify([first, second])
    const entry = this.counts.get(key) ?? { first, second, rows: 0 }
    entry.rows += 1
    this.counts.set(key, entry)
  }

  get size(): number {
    return this.counts.size
  }

  sorted() {
    return [...this.counts.values()].sort(
      (a, b) => compareText(a.first, b.first) || compareText(a.second, b.second),
    )
  }
}

function compareText(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function reviewOf(
  row: WorkbookRow,
  kind: string,
  message: string,
  value: unknown = '',
): ReviewItem {
  return { sheet: row.sheet, row: row.row, kind, message, value: cleanText(value) }
}

/** Fuzzy-matches association names within a municipality: the database first, then this file. */
class AssociationMatcher {
  private readonly known: { name: string; id: string | null }[]

  constructor(
    existing: AssociationDoc[],
    private readonly overrides: Map<string, string>,
  ) {
    this.known = existing.map((row) => ({ name: row.name, id: row._id }))
  }

  match(raw: string): AssociationChoice {
    const key = normalizeName(raw)
    const override = this.overrides.get(key)
    if (override && override !== 'new') {
      const name = this.known.find((item) => item.id === override)?.name ?? raw
      return { raw, canonical: name, existingId: override, score: 100, decision: 'existing' }
    }
    let score = 0
    let best: { name: string; id: string | null } = { name: raw, id: null }
    for (const item of this.known) {
      const candidate = Math.trunc(tokenSortRatio(key, normalizeName(item.name)))
      if (candidate > score) {
        score = candidate
        best = item
      }
    }
    if (override === 'new' || score < ASSOCIATION_REVIEW) {
      this.known.push({ name: raw, id: null })
      return { raw, canonical: raw, existingId: null, score, decision: 'new' }
    }
    if (score >= ASSOCIATION_AUTO) {
      return {
        raw,
        canonical: best.name,
        existingId: best.id,
        score,
        decision: best.id ? 'existing' : 'same_as_file',
      }
    }
    this.known.push({ name: raw, id: null })
    return { raw, canonical: raw, existingId: null, score, decision: 'review' }
  }
}

interface PlanContext {
  resolveVariety: (raw: string) => VarietyDoc | undefined
  resolveSource: (raw: string) => MaterialSourceDoc | undefined
  matcher: AssociationMatcher
  review: ReviewItem[]
  tally: Record<string, Tally>
}

function planRow(raw: WorkbookRow, town: string, context: PlanContext): PlannedRow {
  const { review, tally, matcher } = context
  const v = raw.values
  const homeRaw = cleanText(v.barangay)
  const home = cleanBarangay(homeRaw, town)
  if (home !== homeRaw) tally.barangay?.add(homeRaw, home)

  const locationRaw = cleanText(v.farm_location)
  const sites = splitSites(locationRaw, town)
  const farm = sites[0] ?? home
  if (locationRaw && normalizeName(farm) !== normalizeName(home)) {
    tally.farm_location?.add(locationRaw, farm)
  }

  const varietyRaw = cleanText(v.variety)
  const varieties = mapTokens(splitValues(varietyRaw), context.resolveVariety)
  if (varietyRaw) {
    tally.variety?.add(varietyRaw, varieties.found.map((row) => row.code).join(', ') || '-')
  }
  for (const token of varieties.unknown) {
    review.push(
      reviewOf(raw, 'unknown_variety', `Unknown variety '${token}' (not imported).`, token),
    )
  }

  const sourceRaw = cleanText(v.source)
  const sources = mapTokens(splitValues(sourceRaw), context.resolveSource)
  if (sourceRaw) {
    tally.source?.add(sourceRaw, sources.found.map((row) => row.code).join(', ') || '-')
  }
  for (const token of sources.unknown) {
    review.push(
      reviewOf(raw, 'unknown_source', `Unknown planting material source '${token}'.`, token),
    )
  }

  const dateCell = v.date_planted
  const years = parseYears(dateCell)
  if (years.issue) {
    review.push(reviewOf(raw, 'unparsed_year', `DATE PLANTED: ${years.issue}.`, dateCell))
  } else if (typeof dateCell === 'string' && years.years.length > 1) {
    tally.date_planted?.add(cleanText(dateCell), years.years.join(', '))
  }

  const counts: Record<string, number | null> = {}
  const issues: string[] = []
  for (const [stage, cell] of Object.entries(raw.counts)) {
    const parsed = parseCount(cell)
    counts[stage] = parsed.value
    if (parsed.issue) {
      issues.push(`${stage}: ${parsed.issue}`)
      review.push(reviewOf(raw, 'invalid_count', `${stage}: ${parsed.issue}.`, cell))
    }
  }

  const remarks = parseRemarks(v.remarks)
  const associations = parseAssociations(v.association).map((name) => matcher.match(name))
  const missing = (
    [
      ['variety', varietyRaw],
      ['date_planted', cleanText(dateCell)],
      ['source', sourceRaw],
      ['contact', cleanText(v.contact)],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([label]) => label as string)
  if (!Object.values(counts).some(Boolean)) missing.push('counts')
  return {
    sheet: raw.sheet,
    row: raw.row,
    municipality: town,
    incomplete: raw.belowTotal,
    fullNameRaw: rowName(raw),
    name: parsePersonName(rowName(raw)),
    homeBarangay: home,
    farmBarangay: farm,
    locationRaw,
    contact: parseContact(v.contact),
    associations,
    varieties: varieties.found,
    sources: sources.found,
    years: years.years,
    counts,
    harvests: remarks.harvests,
    remarks: remarks.remaining,
    rawVariety: varietyRaw,
    rawSource: sourceRaw,
    rawDate: cleanText(dateCell),
    missing,
    issues,
  }
}

function flagRepeatedNames(rows: PlannedRow[], review: ReviewItem[]): void {
  const byName = new Map<string, PlannedRow[]>()
  for (const row of rows) {
    const key = normalizePersonName(row.fullNameRaw)
    byName.set(key, [...(byName.get(key) ?? []), row])
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue
    const sameIdentity = new Set(group.map(rowIdentity)).size === 1
    const kind = sameIdentity ? 'same_name_twice' : 'possible_duplicate'
    const message = sameIdentity
      ? 'Same name and barangay twice: imported as ONE farmer with several farms. ' +
        'Split them if they are different people.'
      : 'Same name in different places: imported as separate farmers. ' +
        'Merge them if they are the same person.'
    for (const row of group) {
      const others = group
        .filter((other) => other !== row)
        .map((other) => `${other.sheet}!${String(other.row)}`)
      review.push({
        sheet: row.sheet,
        row: row.row,
        kind,
        message: `${message} Other rows: ${others.join(', ')}.`,
        value: '',
      })
    }
  }
}

export async function buildPlan(
  workbook: ParsedWorkbook,
  commodity: CommodityDoc,
  associationOverrides: Record<string, string> = {},
): Promise<WorkbookPlan> {
  const varieties = await varietyIndex(commodity._id)
  const sources = await sourceIndex()
  const overrides = new Map(
    Object.entries(associationOverrides).map(([key, value]) => [normalizeName(key), value]),
  )
  const [towns, barangayRows, associationRows] = await Promise.all([
    Municipality.find().lean(),
    Barangay.find().lean<BarangayDoc[]>(),
    Association.find().lean<AssociationDoc[]>(),
  ])
  const townByName = new Map(towns.map((town) => [town.name, town]))
  const known = new Set(barangayRows.map((row) => `${row.municipalityId}|${row.normalizedName}`))

  const rows: PlannedRow[] = []
  const review: ReviewItem[] = []
  const tally: Record<string, Tally> = {
    barangay: new Tally(),
    farm_location: new Tally(),
    variety: new Tally(),
    source: new Tally(),
    date_planted: new Tally(),
  }
  const newBarangays = new Tally()
  const associationDecisions: Record<string, unknown>[] = []
  const counts: Record<string, number> = {}
  const bump = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1
  }
  const sheetIssues = [
    ...workbook.sheets.flatMap((sheet) => sheet.issues.map((issue) => `${sheet.name}: ${issue}`)),
    ...workbook.summaryIssues,
    ...workbook.unknownSheets.map((title) => `Unknown sheet ignored: ${title}`),
  ]

  for (const sheet of workbook.sheets) {
    const town = sheet.municipality
    const townId = townByName.get(town)?._id
    const matcher = new AssociationMatcher(
      associationRows.filter((row) => row.municipalityId === townId),
      overrides,
    )
    const context: PlanContext = {
      resolveVariety: (raw) => varieties.resolve(raw),
      resolveSource: (raw) => sources.resolve(raw),
      matcher,
      review,
      tally,
    }
    for (const raw of sheet.rows) {
      const name = rowName(raw)
      const hasCounts = Object.values(raw.counts).some((cell) => parseCount(cell).value)
      if (raw.belowTotal) {
        if (!cleanText(raw.values.barangay)) {
          bump('name_only_rows')
          review.push(
            reviewOf(
              raw,
              'name_only_row',
              'Row below the TOTAL with only a name (signatory or note?). Not imported.',
              name,
            ),
          )
          continue
        }
        bump('below_total_rows')
      } else if (!name) {
        if (hasCounts) {
          bump('unnamed_rows_with_counts')
          review.push(
            reviewOf(
              raw,
              'counts_without_name',
              'Tree counts without a farmer name. Not imported.',
            ),
          )
        }
        continue
      } else {
        bump('named_rows')
        if (hasCounts) bump('rows_with_trees')
      }

      const planned = planRow(raw, town, context)
      if (!planned.homeBarangay) {
        // The row still counts in the official totals (brief §3): keep it, flag it, and file it
        // under FARM LOCATION or an explicit placeholder (ADR-0013).
        planned.missing.push('barangay')
        planned.homeBarangay = planned.farmBarangay || UNRECORDED_BARANGAY
        planned.farmBarangay = planned.farmBarangay || UNRECORDED_BARANGAY
        review.push(
          reviewOf(
            raw,
            'missing_barangay',
            `BARANGAY is empty: filed under '${planned.homeBarangay}'. ` +
              "Correct the farmer's barangay.",
          ),
        )
      }
      for (const choice of planned.associations) {
        if (choice.decision === 'review') {
          review.push(
            reviewOf(
              raw,
              'association_review',
              `'${choice.raw}' is similar (${String(choice.score)}%) to an existing association; ` +
                'imported as a new one unless you map it.',
              choice.raw,
            ),
          )
        }
      }
      for (const name_ of [planned.homeBarangay, planned.farmBarangay]) {
        if (name_ && !known.has(`${townId ?? ''}|${normalizeName(name_)}`)) {
          newBarangays.add(town, name_)
        }
      }
      rows.push(planned)
    }
    const latest = new Map<string, AssociationChoice>()
    for (const row of rows) {
      if (row.municipality !== town) continue
      for (const choice of row.associations) latest.set(choice.raw, choice)
    }
    for (const [raw, choice] of latest) {
      associationDecisions.push({
        municipality: town,
        raw,
        use: choice.canonical,
        decision: choice.decision,
        score: choice.score,
      })
    }
  }

  flagRepeatedNames(rows, review)
  counts.farmers = new Set(rows.map(rowIdentity)).size
  counts.records = rows.length
  counts.incomplete_records = rows.filter((row) => row.incomplete).length
  counts.harvests = rows.reduce((sum, row) => sum + row.harvests.length, 0)
  counts.review_items = review.length
  counts.new_barangays = newBarangays.size

  // Normalization decisions, grouped by raw value: "BR 25" -> "BR25" (3 rows), and so on.
  const decisions: Record<string, Record<string, unknown>[]> = {}
  for (const [kind, counter] of Object.entries(tally)) {
    if (counter.size === 0) continue
    decisions[kind] = counter
      .sorted()
      .map(({ first, second, rows: count }) => ({ raw: first, result: second, rows: count }))
  }
  if (newBarangays.size > 0) {
    decisions.new_barangays = newBarangays.sorted().map(({ first, second, rows: count }) => ({
      municipality: first,
      barangay: second,
      rows: count,
    }))
  }
  decisions.associations = associationDecisions
  return {
    rows,
    review,
    decisions,
    counts,
    reconciliation: await reconcile(workbook, commodity),
    sheetIssues,
  }
}

// --- Reconciliation

export interface ReconciliationCell {
  computed: number
  workbook: number | null
  summary: number | null
  diff_workbook: number | null
  diff_summary: number | null
  formula: string
  skipped_rows: number[]
  uncovered_rows: number[]
}

export interface Reconciliation {
  stages: string[]
  municipalities: {
    municipality: string
    stages: Record<string, ReconciliationCell>
    computed_total: number
    workbook_total: number
    diff_total: number
  }[]
  province: {
    computed: Record<string, number>
    workbook: Record<string, number>
    summary: Record<string, number>
    computed_total: number
    workbook_total: number
    summary_total: number
    area_ha: string | null
  }
  differences: string[]
}

const withCommas = (value: number) => value.toLocaleString('en-US')
const signed = (value: number) => `${value > 0 ? '+' : ''}${withCommas(value)}`

/** [49, 50, 51, 60] -> '49-51, 60'. */
export function describeRanges(rows: number[]): string {
  const parts: [number, number][] = []
  for (const row of rows) {
    const last = parts.at(-1)
    if (last && last[1] === row - 1) last[1] = row
    else parts.push([row, row])
  }
  return parts
    .map(([start, end]) => (start === end ? String(start) : `${String(start)}-${String(end)}`))
    .join(', ')
}

function skippedRows(sheet: WorkbookSheet, stage: string): number[] {
  const total = sheet.totals[stage]
  if (!total?.formula) return []
  const covered = new Set(total.coveredRows)
  return aboveTotal(sheet)
    .filter((row) => parseCount(row.counts[stage]).value)
    .map((row) => row.row)
    .filter((row) => !covered.has(row))
}

/** Data rows above the TOTAL that the stage's SUM leaves out, with or without values. */
function uncoveredRows(sheet: WorkbookSheet, stage: string): number[] {
  const total = sheet.totals[stage]
  const rows = aboveTotal(sheet)
  const first = rows[0]?.row
  const last = rows.at(-1)?.row
  if (!total?.formula || first === undefined || last === undefined) return []
  const covered = new Set(total.coveredRows)
  const uncovered: number[] = []
  for (let row = first; row <= last; row += 1) if (!covered.has(row)) uncovered.push(row)
  return uncovered
}

/** Farmer rows against the workbook's own TOTAL rows and the SUMMARY sheet. */
export async function reconcile(
  workbook: ParsedWorkbook,
  commodity: CommodityDoc,
): Promise<Reconciliation> {
  const stageRows = await GrowthStage.find({ commodityId: commodity._id })
    .sort({ sortOrder: 1 })
    .lean<GrowthStageDoc[]>()
  const stages = stageRows.map((stage) => stage.code)
  const density = plantsPerHa(commodity)
  const municipalities: Reconciliation['municipalities'] = []
  const differences: string[] = []
  const province = {
    computed: {} as Record<string, number>,
    workbook: {} as Record<string, number>,
    summary: {} as Record<string, number>,
  }
  const add = (bucket: Record<string, number>, stage: string, value: number) => {
    bucket[stage] = (bucket[stage] ?? 0) + value
  }

  for (const sheet of workbook.sheets) {
    const summary = workbook.summary[normalizeName(sheet.municipality)]
    const cells: Record<string, ReconciliationCell> = {}
    const rows = aboveTotal(sheet)
    for (const stage of stages) {
      const computed = rows.reduce(
        (sum, row) => sum + (parseCount(row.counts[stage]).value ?? 0),
        0,
      )
      const total = sheet.totals[stage]
      const shown = total ? workbookValue(total) : null
      const inSummary = summary?.population[stage] ?? null
      const skipped = skippedRows(sheet, stage)
      const uncovered = uncoveredRows(sheet, stage)
      const cell: ReconciliationCell = {
        computed,
        workbook: shown,
        summary: inSummary,
        diff_workbook: shown === null ? null : computed - shown,
        diff_summary: inSummary === null ? null : computed - inSummary,
        formula: total?.formula ?? '',
        skipped_rows: skipped,
        uncovered_rows: uncovered,
      }
      cells[stage] = cell
      add(province.computed, stage, computed)
      add(province.workbook, stage, shown ?? 0)
      add(province.summary, stage, inSummary ?? 0)
      const label = `${sheet.municipality} ${stage}`
      if (cell.diff_workbook) {
        const detail =
          skipped.length > 0 ? `; ${cell.formula} skips rows ${describeRanges(skipped)}` : ''
        differences.push(
          `${label}: TOTAL row ${withCommas(shown ?? 0)} vs farmer rows ${withCommas(computed)} ` +
            `(${signed(cell.diff_workbook)})${detail}`,
        )
      }
      if (uncovered.length > 0 && !cell.diff_workbook) {
        differences.push(
          `${label}: ${cell.formula} does not cover rows ${describeRanges(uncovered)} ` +
            '(no effect on the current values, but new entries there would not be totalled)',
        )
      }
      if (cell.diff_summary && cell.diff_summary !== cell.diff_workbook) {
        differences.push(
          `${label}: SUMMARY ${withCommas(inSummary ?? 0)} vs farmer rows ${withCommas(computed)} ` +
            `(${signed(cell.diff_summary)})`,
        )
      }
    }
    const values = Object.values(cells)
    const computedTotal = values.reduce((sum, cell) => sum + cell.computed, 0)
    const workbookTotal = values.reduce((sum, cell) => sum + (cell.workbook ?? 0), 0)
    municipalities.push({
      municipality: sheet.municipality,
      stages: cells,
      computed_total: computedTotal,
      workbook_total: workbookTotal,
      diff_total: computedTotal - workbookTotal,
    })
  }

  const totalOf = (bucket: Record<string, number>) =>
    Object.values(bucket).reduce((sum, value) => sum + value, 0)
  const computedTotal = totalOf(province.computed)
  return {
    stages,
    municipalities,
    province: {
      ...province,
      computed_total: computedTotal,
      workbook_total: totalOf(province.workbook),
      summary_total: totalOf(province.summary),
      area_ha: density ? new HalfUp(computedTotal).dividedBy(density).toFixed(2) : null,
    },
    differences,
  }
}
