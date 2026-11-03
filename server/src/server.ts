import { createApp } from './app.js'
import { connectDatabase, disconnectDatabase } from './config/database.js'
import { EnvError, loadEnv, type Env } from './config/env.js'
import { logger, safeErrorDetails } from './lib/logger.js'

const RETRY_MS = 10_000

function readSettings(): Env {
  try {
    return loadEnv()
  } catch (error) {
    if (!(error instanceof EnvError)) throw error
    console.error(error.message)
    process.exit(1)
  }
}

const env = readSettings()
const production = env.NODE_ENV === 'production'
let stopping = false
let retryTimer: NodeJS.Timeout | undefined

// The server stays up while the database is away, so the health endpoint can report it.
async function connectWithRetry(): Promise<void> {
  try {
    await connectDatabase(env.MONGODB_URI, env.MONGODB_DB, { autoIndex: !production })
    logger.info('database.connected', { database: env.MONGODB_DB })
  } catch (error) {
    logger.error('database.connect_failed', { ...safeErrorDetails(error), retryMs: RETRY_MS })
    if (!stopping) {
      retryTimer = setTimeout(() => void connectWithRetry(), RETRY_MS)
    }
  }
}

const server = createApp({ production }).listen(env.PORT, env.HOST, (error) => {
  if (error) {
    logger.error('server.listen_failed', safeErrorDetails(error))
    process.exit(1)
  }
  logger.info('server.listening', { host: env.HOST, port: env.PORT })
})
void connectWithRetry()

function shutdown(): void {
  stopping = true
  clearTimeout(retryTimer)
  server.close(() => {
    void disconnectDatabase().finally(() => process.exit(0))
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
