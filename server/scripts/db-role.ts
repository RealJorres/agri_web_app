/**
 * The application's database role (ADR-0022, docs/deployment.md).
 *   npm run db-role -w server             prints the privileges to set up in Atlas
 *   npm run db-role -w server -- --check  tests them, using the account in MONGODB_URI
 * The check writes nothing that stays. Run it with the application's account, not an administrator's.
 */
import mongoose from 'mongoose'

import { connectDatabase, disconnectDatabase } from '../src/config/database.js'
import { loadEnv } from '../src/config/env.js'
import { appRolePrivileges, checkDbRole } from '../src/lib/dbRole.js'
import '../src/models/index.js'

const env = loadEnv()
const collections = Object.values(mongoose.models).map((model) => model.collection.name)

if (!process.argv.includes('--check')) {
  const privileges = appRolePrivileges(env.MONGODB_DB, collections)
  console.log(JSON.stringify({ roleName: 'agriApp', actions: privileges }, null, 2))
} else {
  await connectDatabase(env.MONGODB_URI, env.MONGODB_DB, { autoIndex: false })
  try {
    const { db } = mongoose.connection
    if (!db) throw new Error('No database connection.')
    const problems = await checkDbRole(
      mongoose.connection.getClient() as never,
      db as never,
      collections,
    )
    if (problems.length > 0) {
      for (const problem of problems) console.error(problem)
      process.exitCode = 1
    } else {
      console.log(`The role is right for all ${String(collections.length)} collections.`)
    }
  } finally {
    await disconnectDatabase()
  }
}
