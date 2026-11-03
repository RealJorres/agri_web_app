import type { Request, RequestHandler } from 'express'

import { DomainError } from '../lib/errors.js'
import type { Cap } from '../lib/roles.js'
import type { Scope } from '../lib/scoping.js'
import { User, type UserDoc } from '../models/account.models.js'
import { getScope } from '../selectors/accounts.selectors.js'
import { readAccessToken } from '../services/auth.service.js'

export interface AuthContext {
  user: UserDoc
  scope: Scope
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext
  }
}

function notAuthenticated(): DomainError {
  return new DomainError(
    'not_authenticated',
    'Authentication credentials were not provided.',
    {},
    401,
  )
}

function badToken(): DomainError {
  return new DomainError('token_not_valid', 'Your session is not valid. Sign in again.', {}, 401)
}

/** Requires a valid access token for an active user, and works out their scope once. */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const header = req.get('authorization')
  if (!header) throw notAuthenticated()
  const [kind, token] = header.split(' ')
  if (kind !== 'Bearer' || !token) throw badToken()
  const userId = await readAccessToken(token)
  if (!userId) throw badToken()
  const user = await User.findOne({ _id: userId, isActive: true }).lean()
  if (!user) throw badToken()
  req.auth = { user, scope: await getScope(user) }
  next()
}

export function requireCapability(capability: Cap): RequestHandler {
  return (req, _res, next) => {
    if (!authOf(req).scope.can(capability)) {
      throw new DomainError(
        'permission_denied',
        'You do not have permission to perform this action.',
        {},
        403,
      )
    }
    next()
  }
}

/** The signed-in user in a handler behind authenticate. */
export function authOf(req: Request): AuthContext {
  if (!req.auth) throw notAuthenticated()
  return req.auth
}
