/**
 * Rebuilds the public demo database from nothing: MONGODB_DB=agri_demo npm run seed-demo -w server
 * Every person in it is made up, so its accounts can be shown on the sign-in page (ADR-0023). It refuses
 * any other database, because it starts by deleting everything in the one it is given. Run it again
 * to undo whatever visitors changed; each run makes new passwords.
 * Writes the value for Netlify's VITE_DEMO_ACCOUNTS to demo-accounts.json, which is gitignored.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import mongoose from 'mongoose'

import { CACAO_SHEETS, buildWorkbook, type Sheet } from '../tests/support/workbookFixture.js'

const DEMO_DB = 'agri_demo'

if (process.env.MONGODB_DB !== DEMO_DB) {
  console.error(
    `This deletes the database it is given, so it only runs with MONGODB_DB=${DEMO_DB}.`,
  )
  process.exit(1)
}
// The synthetic workbook need not stay on this machine.
const files = mkdtempSync(join(tmpdir(), 'agri-demo-files-'))
process.env.PRIVATE_FILES_DIR = files

const { connectDatabase, disconnectDatabase } = await import('../src/config/database.js')
const { loadEnv } = await import('../src/config/env.js')
const { Role, ROLE_LABELS } = await import('../src/lib/roles.js')
const { Commodity, GrowthStage } = await import('../src/models/catalog.models.js')
const { CropStand } = await import('../src/models/farm.models.js')
const { Municipality } = await import('../src/models/location.models.js')
await import('../src/models/index.js')
const { createAssignment, createUser } = await import('../src/services/accounts.service.js')
const { commitJob, createJob, runPreview, systemActor } =
  await import('../src/services/imports/jobs.service.js')
const { runSeed } = await import('../src/services/seed.service.js')
const survey = await import('../src/services/survey.service.js')

const env = loadEnv()
if (env.MONGODB_DB !== DEMO_DB) throw new Error('Refusing to touch any other database.')

/** More farmers in the town the validator and field encoder cover, so each stage has records. */
const DEMO_SHEETS: Sheet[] = CACAO_SHEETS.map((sheet) =>
  sheet.town !== 'Gasan'
    ? sheet
    : {
        ...sheet,
        rows: [
          ...sheet.rows,
          ...['Aurora', 'Benito', 'Celia', 'Danilo', 'Estela'].map((first, i) => ({
            name: `${first} Samplegas`,
            barangay: 'Synthetic Tabionan',
            counts: [5 + i, 40 + 6 * i, 12 + i, 25 + 3 * i],
          })),
        ],
      },
)

await connectDatabase(env.MONGODB_URI, DEMO_DB, { autoIndex: true })
try {
  await mongoose.connection.dropDatabase()
  for (const model of Object.values(mongoose.models)) {
    await model.createCollection()
    await model.createIndexes()
  }
  await runSeed(join(tmpdir(), 'agri-demo-no-reference-files'))

  const gasan = await Municipality.findOne({ name: 'Gasan' }).lean()
  if (!gasan) throw new Error('Municipalities were not seeded.')

  // One account per role. The two town-level roles cover Gasan, where the workflow records are.
  const roles = [
    [Role.SYSTEM_ADMIN, 'admin', null],
    [Role.PROVINCIAL_HEAD, 'head', null],
    [Role.PROGRAM_COORDINATOR, 'coordinator', null],
    [Role.PROVINCIAL_ENCODER, 'encoder', null],
    [Role.MAO_VALIDATOR, 'validator', gasan._id],
    [Role.FIELD_ENCODER, 'field', gasan._id],
    [Role.VIEWER, 'viewer', null],
  ] as const
  const accounts = []
  for (const [index, [role, name, municipalityId]] of roles.entries()) {
    const email = `${name}@demo.test`
    const password = randomBytes(12).toString('base64url')
    const user = await createUser({
      email,
      password,
      firstName: ROLE_LABELS[role],
      lastName: `Sample${String(index + 1)}`,
      actorId: null,
    })
    await createAssignment({ userId: user._id, role, municipalityId, actorId: null })
    const area = municipalityId ? ' (Gasan)' : ''
    accounts.push({ role: `${ROLE_LABELS[role]}${area}`, email, password })
  }

  const actor = await systemActor()
  const crop = await Commodity.findOne({ code: 'CACAO' }).lean()
  if (!crop) throw new Error('The catalog was not seeded.')

  // A past round, imported the way a real workbook would be.
  const created = await createJob({
    actor,
    name: 'sample-inventory-2023.xlsx',
    content: await buildWorkbook(DEMO_SHEETS),
    kind: 'legacy_workbook',
    commodityId: crop._id,
    roundName: 'Sample inventory 2023',
    asOfDate: '2023-07-31',
    enforceScope: false,
  })
  const previewed = await runPreview(created._id)
  if (previewed.status !== 'ready') throw new Error('The sample workbook did not preview.')
  await commitJob({ jobId: created._id, actor, enforceScope: false })

  // A current round, with Gasan's records at every stage so that each role has something to do.
  const round = await survey.openRound({
    actor,
    commodityId: crop._id,
    name: 'Sample inventory 2026',
    asOfDate: '2026-06-30',
  })
  const stages = await GrowthStage.find({ commodityId: crop._id }).sort({ sortOrder: 1 }).lean()
  const stands = await CropStand.find({ commodityId: crop._id }).sort({ _id: 1 }).lean()
  const GASAN_STAGES = [
    'draft',
    'returned',
    'submitted',
    'submitted',
    'validated',
    'validated',
    'approved',
  ]
  const tally: Record<string, number> = {}
  let inGasan = 0
  for (const [index, stand] of stands.entries()) {
    const isGasan = stand.municipalityId === gasan._id
    const target = isGasan ? (GASAN_STAGES[inGasan++] ?? 'approved') : 'approved'
    try {
      const record = await survey.createRecord({
        actor,
        roundId: round._id,
        standId: stand._id,
        counts: stages.map((stage, position) => ({
          growthStageId: stage._id,
          count: 8 + ((index * 7 + position * 13) % 60),
        })),
      })
      const recordId = record._id
      if (target !== 'draft') await survey.submit({ actor, recordId })
      if (target === 'returned') {
        const comment = 'Sample comment: please recheck the fruiting count.'
        await survey.returnRecord({ actor, recordId, comment })
      }
      if (target === 'validated' || target === 'approved')
        await survey.validate({ actor, recordId })
      if (target === 'approved') await survey.approve({ actor, recordId })
      tally[target] = (tally[target] ?? 0) + 1
    } catch {
      // A sample row with a deliberate defect, such as no barangay, stays out of this round.
      tally.skipped = (tally.skipped ?? 0) + 1
    }
  }

  const output = join(import.meta.dirname, '..', '..', 'demo-accounts.json')
  writeFileSync(output, `${JSON.stringify(accounts)}\n`)
  console.log(
    `Rebuilt ${DEMO_DB}: ${String(accounts.length)} accounts, 2026 records ${JSON.stringify(tally)}.`,
  )
  console.log('Wrote demo-accounts.json, the value for VITE_DEMO_ACCOUNTS.')
} finally {
  await disconnectDatabase()
  rmSync(files, { recursive: true, force: true })
}
