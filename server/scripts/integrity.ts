/**
 * Reports broken references and copied keys that disagree with their source:
 * npm run integrity -w server
 * Prints ids only, and exits with 1 if it finds anything.
 */
import { connectDatabase, disconnectDatabase } from '../src/config/database.js'
import { loadEnv } from '../src/config/env.js'
import { integrityProblems } from '../src/selectors/integrity.selectors.js'

const env = loadEnv()
await connectDatabase(env.MONGODB_URI, env.MONGODB_DB, { autoIndex: false })
try {
  const problems = await integrityProblems()
  for (const { check, count, sampleIds } of problems) {
    console.error(`${check}: ${String(count)} (for example ${sampleIds.join(', ')})`)
  }
  console.log(
    problems.length === 0
      ? `No problems found in database ${env.MONGODB_DB}.`
      : `${String(problems.length)} checks failed in database ${env.MONGODB_DB}.`,
  )
  if (problems.length > 0) process.exitCode = 1
} finally {
  await disconnectDatabase()
}
