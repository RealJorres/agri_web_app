import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import mongoose from 'mongoose'
import { afterAll, beforeAll, inject } from 'vitest'

import { connectDatabase, disconnectDatabase } from '../../src/config/database.js'
import { settleBackgroundTasks } from '../../src/lib/background.js'

// Test files run in parallel, so each gets its own database on the shared replica set.
const dbName = `test_${process.env.VITEST_POOL_ID ?? '0'}_${String(process.pid)}`

// Stored uploads go to a throwaway folder, never the project's own.
const privateFiles = mkdtempSync(join(tmpdir(), 'agri-private-'))
process.env.PRIVATE_FILES_DIR = privateFiles

beforeAll(async () => {
  await connectDatabase(inject('mongoUri'), dbName, { autoIndex: true })
})

afterAll(async () => {
  await settleBackgroundTasks()
  await mongoose.connection.dropDatabase()
  await disconnectDatabase()
  rmSync(privateFiles, { recursive: true, force: true })
})
