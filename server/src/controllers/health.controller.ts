import type { Request, Response } from 'express'

import { isDatabaseReachable } from '../selectors/health.selectors.js'

/** Liveness and readiness probe. Reports only up or down, never error details. */
export async function getHealth(_req: Request, res: Response): Promise<void> {
  const healthy = await isDatabaseReachable()
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    checks: { database: healthy ? 'ok' : 'down' },
  })
}
