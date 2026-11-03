/**
 * Creates every collection and index: npm run create-indexes -w server
 * The running application in production creates neither, so this runs before it first starts, and
 * again after a release that changes an index. It needs an administrator's account. Safe to re-run.
 */
import mongoose from 'mongoose'

import { connectDatabase, disconnectDatabase } from '../src/config/database.js'
import { loadEnv } from '../src/config/env.js'
import '../src/models/index.js'

const env = loadEnv()
await connectDatabase(env.MONGODB_URI, env.MONGODB_DB, { autoIndex: false })
try {
  const models = Object.values(mongoose.models)
  for (const model of models) {
    await model.createCollection()
    await model.createIndexes()
  }
  console.log(
    `Collections and indexes are ready in database ${env.MONGODB_DB}: ${String(models.length)}.`,
  )
} finally {
  await disconnectDatabase()
}
