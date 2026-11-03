import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { createApp } from './app.js'
import { connectDatabase, disconnectDatabase } from './config/database.js'
import { EnvError, loadEnv, type Env } from './config/env.js'
import { settleBackgroundTasks } from './lib/background.js'
import { logger, safeErrorDetails } from './lib/logger.js'
import { municipalitiesWithoutPsgc } from './selectors/location.selectors.js'
import { failInterruptedJobs, purgeOldFiles } from './services/imports/jobs.service.js'

const RETRY_MS = 10_000
const ONE_DAY_MS = 86_400_000

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
let purgeTimer: NodeJS.Timeout | undefined

function purgeFiles(): void {
  purgeOldFiles().catch((error: unknown) => {
    logger.error('imports.purge_failed', safeErrorDetails(error))
  })
}

async function startImportHousekeeping(): Promise<void> {
  try {
    const interrupted = await failInterruptedJobs()
    if (interrupted > 0) logger.warn('imports.interrupted', { jobs: interrupted })
  } catch (error) {
    logger.error('imports.recovery_failed', safeErrorDetails(error))
  }
  purgeFiles()
  purgeTimer = setInterval(purgeFiles, ONE_DAY_MS)
  purgeTimer.unref()
}

// The server stays up while the database is away, so the health endpoint can report it.
async function connectWithRetry(): Promise<void> {
  try {
    await connectDatabase(env.MONGODB_URI, env.MONGODB_DB, { autoIndex: !production })
    logger.info('database.connected', { database: env.MONGODB_DB })
    void startImportHousekeeping()
    if (production) {
      const missing = await municipalitiesWithoutPsgc()
      if (missing.length > 0) {
        logger.warn('locations.psgc_codes_missing', { municipalities: missing.join(', ') })
      }
    }
  } catch (error) {
    logger.error('database.connect_failed', { ...safeErrorDetails(error), retryMs: RETRY_MS })
    if (!stopping) {
      retryTimer = setTimeout(() => void connectWithRetry(), RETRY_MS)
    }
  }
}

/** Serves the built frontend too, when told where it is (ADR-0023). */
function builtFrontend(): string | undefined {
  if (!env.STATIC_DIR) return undefined
  if (!existsSync(join(env.STATIC_DIR, 'index.html'))) {
    console.error('STATIC_DIR has no built frontend in it. Run npm run build first.')
    process.exit(1)
  }
  return env.STATIC_DIR
}

const staticDir = builtFrontend()
const app = createApp({
  production,
  trustedProxies: env.TRUSTED_PROXY_COUNT,
  csrfTrustedOrigins: [
    ...env.CSRF_TRUSTED_ORIGINS,
    ...(env.PUBLIC_ORIGIN ? [env.PUBLIC_ORIGIN] : []),
  ],
  ...(env.PUBLIC_ORIGIN ? { publicOrigin: env.PUBLIC_ORIGIN } : {}),
  ...(staticDir ? { staticDir } : {}),
  ...(env.MAP_TILE_URL ? { tileUrl: env.MAP_TILE_URL } : {}),
})
const server = app.listen(env.PORT, env.HOST, (error) => {
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
  clearInterval(purgeTimer)
  server.close(() => {
    void settleBackgroundTasks()
      .then(disconnectDatabase)
      .finally(() => process.exit(0))
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
