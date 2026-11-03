import mongoose from 'mongoose'
import { afterAll, beforeAll, inject } from 'vitest'

import { connectDatabase, disconnectDatabase } from '../../src/config/database.js'

// Test files run in parallel, so each gets its own database on the shared replica set.
const dbName = `test_${process.env.VITEST_POOL_ID ?? '0'}_${String(process.pid)}`

beforeAll(async () => {
  await connectDatabase(inject('mongoUri'), dbName, { autoIndex: true })
})

afterAll(async () => {
  await mongoose.connection.dropDatabase()
  await disconnectDatabase()
})
