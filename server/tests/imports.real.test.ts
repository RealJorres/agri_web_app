/**
 * Acceptance tests against the REAL PAO workbook (brief §3), in the in-memory database only. Skipped
 * when data/raw/ has no workbook, as in CI and fresh clones. They assert counts and totals only:
 * nothing here compares or prints names, so a failure cannot show personal data.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { Role } from '../src/lib/roles.js'
import type { Actor } from '../src/lib/scoping.js'
import type { ImportJobDoc } from '../src/models/import.models.js'
import { InventoryRecord, SurveyRound, type SurveyRoundDoc } from '../src/models/survey.models.js'
import { integrityProblems } from '../src/selectors/integrity.selectors.js'
import { stageTotals } from '../src/selectors/survey.selectors.js'
import { getScope } from '../src/selectors/accounts.selectors.js'
import { seedCatalog } from '../src/services/catalog.service.js'
import { commitJob, createJob, runPreview } from '../src/services/imports/jobs.service.js'
import type { Reconciliation } from '../src/services/imports/workbookPlan.js'
import { seedMunicipalities } from '../src/services/location.service.js'
import { summaryPdf, summaryXlsx } from '../src/services/reportRender.js'
import { breakdown, overview } from '../src/selectors/analytics.selectors.js'
import { contentHash, summaryContent } from '../src/selectors/report.selectors.js'
import { FULL_SCOPE } from '../src/lib/scoping.js'
import { actorFor, userWithRole } from './support/factories.js'

const RAW_DIR = join(import.meta.dirname, '..', '..', 'data', 'raw')

function findWorkbook(): string | undefined {
  try {
    const name = readdirSync(RAW_DIR).find((file) => /cacao.*2023.*\.xlsx$/iu.test(file))
    return name && join(RAW_DIR, name)
  } catch {
    return undefined
  }
}

const REAL_FILE = findWorkbook()
const STAGES = ['SEEDLING', 'VEGETATIVE', 'FLOWERING', 'FRUITING']
const TRUE_TOTALS: Record<string, number[]> = {
  Boac: [30, 3_205, 1_365, 2_475],
  Buenavista: [7_085, 4_175, 615, 3_244],
  Mogpog: [1_053, 1_332, 600, 988],
  Gasan: [2_750, 5_650, 1_915, 3_520],
  'Santa Cruz': [1_483, 14_655, 6_205, 9_334],
  Torrijos: [1_230, 3_800, 3_333, 1_670],
}
const PROVINCE = [13_631, 32_817, 14_033, 21_231]

describe.skipIf(REAL_FILE === undefined)('the real workbook', () => {
  let admin: Actor
  let job: ImportJobDoc
  let rec: Reconciliation

  const town = (name: string) => rec.municipalities.find((row) => row.municipality === name)
  const decisions = () => job.summary.decisions as Record<string, unknown[] | undefined>

  beforeAll(async () => {
    await Promise.all([InventoryRecord.init(), SurveyRound.init()])
    await seedMunicipalities()
    await seedCatalog()
    admin = await actorFor(await userWithRole(Role.SYSTEM_ADMIN))
    const created = await createJob({
      actor: admin,
      name: 'real.xlsx',
      content: readFileSync(REAL_FILE as string),
      kind: 'legacy_cacao_2023',
    })
    job = await runPreview(created._id)
    rec = job.summary.reconciliation as Reconciliation
  }, 120_000)

  it('previews without an error', () => {
    expect(job.status).toBe('ready')
    expect(job.errorMessage).toBe('')
  })

  it('finds 212 named rows, 208 with trees', () => {
    const counts = job.summary.counts as Record<string, number>
    expect(counts.named_rows).toBe(212)
    expect(counts.rows_with_trees).toBe(208)
  })

  it('gets every municipal and provincial figure in brief §3', () => {
    for (const [name, expected] of Object.entries(TRUE_TOTALS)) {
      expect(STAGES.map((stage) => town(name)?.stages[stage]?.computed)).toEqual(expected)
    }
    expect(STAGES.map((stage) => rec.province.computed[stage])).toEqual(PROVINCE)
    expect(rec.province.computed_total).toBe(81_712)
    expect(rec.province.area_ha).toBe('130.74')
  })

  it('shows Santa Cruz at +940 against the workbook', () => {
    const santaCruz = town('Santa Cruz')
    expect(santaCruz?.diff_total).toBe(940)
    expect(STAGES.map((stage) => santaCruz?.stages[stage]?.diff_workbook)).toEqual([
      220, 350, 370, 0,
    ])
    expect(rec.province.workbook_total).toBe(80_772)
  })

  it('reports the Mogpog single-cell flowering total', () => {
    const flowering = town('Mogpog')?.stages.FLOWERING
    expect(flowering?.formula.toUpperCase()).toBe('=SUM(L28)')
    expect(flowering?.uncovered_rows.length).toBeGreaterThan(0)
    expect(
      rec.differences.some((line) => {
        return line.includes('Mogpog FLOWERING') && line.includes('does not cover')
      }),
    ).toBe(true)
  })

  it('matches the raw spelling counts in brief §3', () => {
    // The brief counts 18 exact spellings. Two differ only by stray spaces, which are merged here.
    expect(decisions().variety).toHaveLength(17)
    expect(decisions().source).toHaveLength(13)
  })

  it('commits to an official total of 81,712, with sound keys', async () => {
    const done = await commitJob({ jobId: job._id, actor: admin })
    const result = done.summary.commit as { official_total: number; survey_round: string }
    expect(result.official_total).toBe(81_712)
    const round = (await SurveyRound.findOne({
      _id: result.survey_round,
    }).lean()) as SurveyRoundDoc
    const totals = await stageTotals(
      round,
      await getScope({ _id: admin.id as string, isActive: true, isSuperuser: true }),
    )
    expect(totals.reduce((sum, row) => sum + row.count, 0)).toBe(81_712)
    for (const [name, expected] of Object.entries(TRUE_TOTALS)) {
      const counts = STAGES.map((stage) => {
        return totals.find((row) => row.municipality === name && row.stageCode === stage)?.count
      })
      expect(counts).toEqual(expected)
    }
    expect((await integrityProblems()).map((problem) => problem.check)).toEqual([])
  }, 120_000)

  it('gives the same figures in analytics and the official report', async () => {
    const round = (await SurveyRound.findOne().lean()) as SurveyRoundDoc
    const data = await overview(FULL_SCOPE, round._id, {})
    expect(data.trees).toBe(81_712)
    expect(data.area_ha).toBe('130.74')
    expect(data.stages.map((stage) => stage.trees)).toEqual(PROVINCE)
    const towns = await breakdown(FULL_SCOPE, round._id, 'municipality', {})
    for (const town of towns) {
      expect(STAGES.map((stage) => town.stages[stage])).toEqual(TRUE_TOTALS[town.name])
    }
    const report = await summaryContent(round, FULL_SCOPE)
    expect(report.total.trees).toEqual(PROVINCE)
    expect(report.total.trees_total).toBe(81_712)
    // ADR-0015: distinct farmers with a tree counted gives 206, where the typed sheet says 209.
    expect(report.total.farmers).toBe(206)
    const farmers = Object.fromEntries(report.rows.map((row) => [row.municipality, row.farmers]))
    expect([farmers.Boac, farmers.Buenavista, farmers.Mogpog]).toEqual([19, 39, 23])
    const first = contentHash(report)
    expect(contentHash(await summaryContent(round, FULL_SCOPE))).toBe(first)
    await expect(summaryPdf(report)).resolves.toBeInstanceOf(Buffer)
    await expect(summaryXlsx(report)).resolves.toBeInstanceOf(Buffer)
  }, 120_000)
})
