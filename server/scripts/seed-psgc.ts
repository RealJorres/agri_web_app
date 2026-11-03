/**
 * Loads official PSGC codes for one province's municipalities and barangays:
 * npm run seed-psgc -w server -- --province Marinduque [--file <path>] [--dry-run]
 * The file defaults to the PSGC file in data/reference/.
 */
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import mongoose from 'mongoose'

import { connectDatabase, disconnectDatabase } from '../src/config/database.js'
import { loadEnv } from '../src/config/env.js'
import { DomainError } from '../src/lib/errors.js'
import { findPsgcFile, loadPsgc } from '../src/services/location.service.js'

const { values } = parseArgs({
  options: {
    province: { type: 'string' },
    file: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
})
const { province, 'dry-run': dryRun } = values
if (province === undefined) {
  console.error(
    'Usage: npm run seed-psgc -w server -- --province <name> [--file <path>] [--dry-run]',
  )
  process.exit(1)
}

const file =
  values.file ?? (await findPsgcFile(join(import.meta.dirname, '..', '..', 'data', 'reference')))
if (file === undefined) {
  console.error('PSGC file not found. Put it in data/reference/ or pass --file.')
  process.exit(1)
}

const env = loadEnv()
await connectDatabase(env.MONGODB_URI, env.MONGODB_DB, { autoIndex: env.NODE_ENV !== 'production' })
try {
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()))
  const report = await loadPsgc(file, { province, dryRun })
  const prefix = dryRun ? '[dry run] ' : ''
  console.log(`${prefix}Municipalities coded: ${report.municipalitiesCoded.join(', ')}`)
  if (report.municipalitiesMissing.length > 0) {
    console.warn(`Not in database: ${report.municipalitiesMissing.join(', ')}`)
  }
  console.log(
    `Barangays verified: ${String(report.barangaysVerified)}, ` +
      `created: ${String(report.barangaysCreated)}`,
  )
  for (const name of report.barangaysUnmatched) {
    console.warn(`Unverified barangay (no PSGC match): ${name}`)
  }
} catch (error) {
  if (!(error instanceof DomainError)) throw error
  console.error(error.message)
  process.exitCode = 1
} finally {
  await disconnectDatabase()
}
