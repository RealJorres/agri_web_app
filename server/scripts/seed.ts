/**
 * Seeds municipalities and the catalog, and PSGC codes if the file is in data/reference/.
 * Safe to run again: npm run seed -w server
 */
import { join } from 'node:path'

import mongoose from 'mongoose'

import { connectDatabase, disconnectDatabase } from '../src/config/database.js'
import { loadEnv } from '../src/config/env.js'
import { runSeed } from '../src/services/seed.service.js'

const env = loadEnv()
await connectDatabase(env.MONGODB_URI, env.MONGODB_DB, { autoIndex: env.NODE_ENV !== 'production' })
try {
  // Collections cannot always be created inside a transaction, so they are made up front.
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()))
  const lines = await runSeed(join(import.meta.dirname, '..', '..', 'data', 'reference'))
  for (const line of lines) console.log(line)
  console.log(`Seeded database ${env.MONGODB_DB}.`)
} finally {
  await disconnectDatabase()
}
