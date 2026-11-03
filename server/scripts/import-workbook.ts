/**
 * Previews and commits a workbook as the system account, then prints the reconciliation:
 * npm run import-workbook -w server -- <file> [--dry-run]
 * npm run import-workbook -w server -- <file> --commodity <code> --round <name> --as-of <YYYY-MM-DD>
 * With no --commodity it imports the 2023 cacao workbook. Prints counts and totals only, never names
 * or other personal data.
 */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'

import mongoose from 'mongoose'

import { connectDatabase, disconnectDatabase } from '../src/config/database.js'
import { loadEnv } from '../src/config/env.js'
import { DomainError } from '../src/lib/errors.js'
import { Commodity } from '../src/models/catalog.models.js'
import {
  commitJob,
  createJob,
  runPreview,
  systemActor,
} from '../src/services/imports/jobs.service.js'
import type { Reconciliation } from '../src/services/imports/workbookPlan.js'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'dry-run': { type: 'boolean', default: false },
    commodity: { type: 'string' },
    round: { type: 'string' },
    'as-of': { type: 'string' },
  },
})
const [file] = positionals
if (file === undefined) {
  console.error('Usage: npm run import-workbook -w server -- <file> [--dry-run]')
  process.exit(1)
}

const group = (value: number) => value.toLocaleString('en-US')
const pad = (text: string | number, width: number) =>
  (typeof text === 'number' ? group(text) : text).padStart(width)

function printPreview(summary: Record<string, unknown>): void {
  const counts = summary.counts as Record<string, number | undefined>
  console.log(
    `Rows: ${String(counts.named_rows ?? 0)} named above TOTAL ` +
      `(${String(counts.rows_with_trees ?? 0)} with trees), ` +
      `${String(counts.below_total_rows ?? 0)} below TOTAL, ` +
      `${String(counts.name_only_rows ?? 0)} name-only, ` +
      `review items: ${String(counts.review_items ?? 0)}`,
  )
  const rec = summary.reconciliation as Reconciliation
  console.log('\nReconciliation (farmer rows vs workbook TOTAL rows):')
  console.log(
    'Municipality'.padEnd(14) +
      rec.stages.map((stage) => pad(stage, 12)).join('') +
      pad('Total', 10) +
      pad('Diff', 8),
  )
  for (const row of rec.municipalities) {
    const cells = rec.stages.map((stage) => pad(row.stages[stage]?.computed ?? 0, 12)).join('')
    const diff = `${row.diff_total > 0 ? '+' : ''}${group(row.diff_total)}`
    console.log(row.municipality.padEnd(14) + cells + pad(row.computed_total, 10) + pad(diff, 8))
  }
  const { province } = rec
  const provinceDiff = province.computed_total - province.workbook_total
  console.log(
    'Province'.padEnd(14) +
      rec.stages.map((stage) => pad(province.computed[stage] ?? 0, 12)).join('') +
      pad(province.computed_total, 10) +
      pad(`${provinceDiff > 0 ? '+' : ''}${group(provinceDiff)}`, 8),
  )
  console.log(
    `Area at configured density: ${province.area_ha ?? 'n/a'} ha; ` +
      `workbook total ${group(province.workbook_total)}`,
  )
  for (const line of rec.differences) console.warn(`  - ${line}`)
  for (const issue of summary.sheet_issues as string[]) console.warn(`  ! ${issue}`)
}

const env = loadEnv()
await connectDatabase(env.MONGODB_URI, env.MONGODB_DB, { autoIndex: env.NODE_ENV !== 'production' })
try {
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()))
  const actor = await systemActor()
  const content = await readFile(file)
  let target: Parameters<typeof createJob>[0] = {
    actor,
    name: basename(file),
    content,
    kind: 'legacy_cacao_2023',
    enforceScope: false,
  }
  if (values.commodity !== undefined) {
    const commodity = await Commodity.findOne({ code: values.commodity }).lean()
    target = {
      ...target,
      kind: 'legacy_workbook',
      commodityId: commodity?._id ?? null,
      roundName: values.round,
      asOfDate: values['as-of'],
    }
  }
  const created = await createJob(target)
  const job = await runPreview(created._id)
  if (job.status !== 'ready') {
    console.error(`Preview failed: ${job.errorMessage}`)
    process.exitCode = 1
  } else {
    printPreview(job.summary)
    if (values['dry-run']) {
      console.log('Dry run: nothing imported.')
    } else {
      if (job.summary.already_imported) {
        console.log('This file was imported before; only new rows will be added.')
      }
      const done = await commitJob({ jobId: job._id, actor, enforceScope: false })
      const result = done.summary.commit as Record<string, number | undefined>
      console.log(
        `Committed: ${String(result.farmers ?? 0)} farmers, ${String(result.farms ?? 0)} farms, ` +
          `${String(result.records_approved ?? 0)} approved + ` +
          `${String(result.records_draft ?? 0)} draft records, ` +
          `${String(result.harvests ?? 0)} harvests ` +
          `(${String(result.rows_already_imported ?? 0)} rows already imported).`,
      )
      console.log(`Official total for the round: ${group(result.official_total ?? 0)} trees`)
      console.log(`Database: ${env.MONGODB_DB}. Import job: ${done._id}`)
    }
  }
} catch (error) {
  if (!(error instanceof DomainError)) throw error
  console.error(error.message)
  process.exitCode = 1
} finally {
  await disconnectDatabase()
}
