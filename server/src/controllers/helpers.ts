import type { Request, RequestHandler, Response } from 'express'

import { DomainError } from '../lib/errors.js'
import { pageOf, pageRequest } from '../lib/pagination.js'
import type { Actor, Scope } from '../lib/scoping.js'
import { authOf } from '../middleware/auth.js'
import { auditTrail } from '../selectors/audit.selectors.js'

export function pathId(req: Request, name = 'id'): string {
  return String(req.params[name])
}

export function actorOf(req: Request): Actor {
  const { user, scope } = authOf(req)
  return { id: user._id, scope }
}

export function scopeOf(req: Request): Scope {
  return authOf(req).scope
}

/** GET {id}/audit: the object lookup enforces scope, so anything out of reach answers 404. */
export function auditHandler(
  objectType: string,
  requireVisible: (scope: Scope, id: string) => Promise<void>,
): RequestHandler {
  return async (req: Request, res: Response) => {
    const id = pathId(req)
    await requireVisible(scopeOf(req), id)
    const page = pageRequest(req)
    const { count, results } = await auditTrail(objectType, id, page)
    res.json(pageOf(req, page, count, results))
  }
}

/** A collection route that exists only to point callers at the right one. */
export function useInstead(code: string, message: string): RequestHandler {
  return () => {
    throw new DomainError(code, message, {}, 405)
  }
}
