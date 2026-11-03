/**
 * Runs the API against a throwaway in-memory database, for trying things with synthetic data and
 * no Atlas connection. Everything is lost on exit. Variables set here win over .env, so this mode
 * can never reach the hosted database.
 *
 * It seeds the reference data and one administrator, whose generated password is printed here only.
 * Set DEV_ADMIN_PASSWORD to choose it.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MongoMemoryReplSet } from 'mongodb-memory-server'
import mongoose from 'mongoose'

const DB_NAME = 'agri_memory'
const ADMIN_EMAIL = 'admin@example.test'

const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
process.env.MONGODB_URI = replSet.getUri()
process.env.MONGODB_DB = DB_NAME
// Uploads are thrown away too, so nothing tried here lands in the project's private folder.
const privateFiles = mkdtempSync(join(tmpdir(), 'agri-dev-files-'))
process.env.PRIVATE_FILES_DIR = privateFiles

function stop(): void {
  rmSync(privateFiles, { recursive: true, force: true })
  void replSet.stop()
}
process.once('exit', stop)
console.log('Using a temporary in-memory database. Data is lost when this stops.')

const { connectDatabase, disconnectDatabase } = await import('../src/config/database.js')
const { createUser } = await import('../src/services/accounts.service.js')
const { runSeed } = await import('../src/services/seed.service.js')
await connectDatabase(replSet.getUri(), DB_NAME, { autoIndex: true })
await Promise.all(Object.values(mongoose.models).map((model) => model.init()))
await runSeed(join(tmpdir(), 'agri-dev-no-reference-files'))
const password = process.env.DEV_ADMIN_PASSWORD ?? randomBytes(15).toString('base64url')
await createUser({
  email: ADMIN_EMAIL,
  password,
  firstName: 'Local',
  lastName: 'Admin',
  isSuperuser: true,
  actorId: null,
})
await disconnectDatabase()
console.log(`Sign in as ${ADMIN_EMAIL} with password: ${password}`)

await import('../src/server.js')
