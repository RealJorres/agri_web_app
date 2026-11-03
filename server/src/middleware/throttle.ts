import type { RequestHandler } from 'express'
import { rateLimit } from 'express-rate-limit'

import { DomainError } from '../lib/errors.js'

const ONE_MINUTE_MS = 60_000
const ONE_HOUR_MS = 3_600_000

function limiter(
  limit: number,
  keyGenerator?: RequestHandlerKey,
  windowMs = ONE_MINUTE_MS,
): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator } : {}),
    handler: (_req, _res, next) => {
      next(new DomainError('throttled', 'Too many requests. Try again shortly.', {}, 429))
    },
  })
}

type RequestHandlerKey = (req: Parameters<RequestHandler>[0]) => string

/** One set of counters per app. Counts live in memory, which suits a single server process. */
export interface Throttles {
  login: RequestHandler
  auth: RequestHandler
  user: RequestHandler
  imports: RequestHandler
}

export function createThrottles(): Throttles {
  return {
    login: limiter(10),
    auth: limiter(30),
    user: limiter(600, (req) => req.auth?.user._id ?? 'anonymous'),
    imports: limiter(20, (req) => req.auth?.user._id ?? 'anonymous', ONE_HOUR_MS),
  }
}
