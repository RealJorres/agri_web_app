import mongoose from 'mongoose'

import { logger, safeErrorDetails } from '../lib/logger.js'

export async function isDatabaseReachable(): Promise<boolean> {
  const { db, readyState } = mongoose.connection
  if (readyState !== mongoose.ConnectionStates.connected || !db) return false
  try {
    await db.admin().ping()
    return true
  } catch (error) {
    logger.warn('health.database_unavailable', safeErrorDetails(error))
    return false
  }
}
