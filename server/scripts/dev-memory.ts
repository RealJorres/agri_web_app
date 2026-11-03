/**
 * Runs the API against a throwaway in-memory database, for trying things with synthetic data and
 * no Atlas connection. Everything is lost on exit. Variables set here win over .env, so this mode
 * can never reach the hosted database.
 */
import { MongoMemoryReplSet } from 'mongodb-memory-server'

const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
process.env.MONGODB_URI = replSet.getUri()
process.env.MONGODB_DB = 'agri_memory'

function stop(): void {
  void replSet.stop()
}
process.once('exit', stop)
console.log('Using a temporary in-memory database. Data is lost when this stops.')

await import('../src/server.js')
