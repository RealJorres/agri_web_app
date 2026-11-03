import { Router, type RequestHandler } from 'express'

import type { Cap } from '../lib/roles.js'
import { authenticate, requireCapability } from '../middleware/auth.js'

/** Every route states who may call it, so a route cannot be left open by forgetting a check. */
export type Access =
  { kind: 'public' } | { kind: 'authenticated' } | { kind: 'capability'; capability: Cap }

export interface RouteDefinition {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete'
  path: string
  access: Access
  handlers: RequestHandler[]
}

export function buildRouter(
  routes: readonly RouteDefinition[],
  { signedIn }: { signedIn: RequestHandler },
): Router {
  const router = Router()
  for (const { method, path, access, handlers } of routes) {
    const guards: RequestHandler[] = []
    if (access.kind !== 'public') guards.push(authenticate, signedIn)
    if (access.kind === 'capability') guards.push(requireCapability(access.capability))
    router[method](path, ...guards, ...handlers)
  }
  return router
}
