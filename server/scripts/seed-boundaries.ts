/**
 * Loads official boundaries from a GeoJSON file or shapefile (ADR-0016):
 * npm run seed-boundaries -w server -- --file <path> --level <municipality|barangay> --province <name>
 *   [--code-field <name>] [--name-field <name>] [--parent-field <name>] [--province-field <name>]
 *   [--dry-run]
 */
import { parseArgs } from 'node:util'

import mongoose from 'mongoose'

import { connectDatabase, disconnectDatabase } from '../src/config/database.js'
import { loadEnv } from '../src/config/env.js'
import { DomainError } from '../src/lib/errors.js'
import { loadBoundaries } from '../src/services/boundary.service.js'

const { values } = parseArgs({
  options: {
    file: { type: 'string' },
    level: { type: 'string' },
    province: { type: 'string' },
    'code-field': { type: 'string' },
    'name-field': { type: 'string' },
    'parent-field': { type: 'string' },
    'province-field': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
})
const { file, level, province, 'dry-run': dryRun } = values
if (file === undefined || level === undefined || province === undefined) {
  console.error(
    'Usage: npm run seed-boundaries -w server -- --file <path> ' +
      '--level <municipality|barangay> --province <name> [--dry-run]',
  )
  process.exit(1)
}

const env = loadEnv()
await connectDatabase(env.MONGODB_URI, env.MONGODB_DB, { autoIndex: env.NODE_ENV !== 'production' })
try {
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()))
  const report = await loadBoundaries(file, {
    level,
    province,
    codeField: values['code-field'],
    nameField: values['name-field'],
    parentField: values['parent-field'],
    provinceField: values['province-field'],
    dryRun,
  })
  const prefix = dryRun ? '[dry run] ' : ''
  console.log(
    `${prefix}Features read: ${String(report.featuresRead)}, ` +
      `outside the province: ${String(report.featuresOutsideProvince)}`,
  )
  console.log(`${prefix}Boundaries loaded: ${String(report.loaded.length)}`)
  const lists: [string, string[]][] = [
    ['No match in the database', report.unmatched],
    ['Ambiguous, not loaded', report.ambiguous],
    ['Unusable shape, not loaded', report.invalid],
    ['In the database, no shape in this file', report.withoutShape],
  ]
  for (const [title, items] of lists) {
    for (const item of items) console.warn(`${title}: ${item}`)
  }
} catch (error) {
  if (!(error instanceof DomainError)) throw error
  console.error(error.message)
  process.exitCode = 1
} finally {
  await disconnectDatabase()
}
