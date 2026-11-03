import { AsyncLocalStorage } from 'node:async_hooks'

import type { RequestHandler } from 'express'

/** Per-request details recorded on audit entries. */
export interface RequestMeta {
  ip: string | null
  userAgent: string
}

const MAX_USER_AGENT = 300
const storage = new AsyncLocalStorage<RequestMeta>()

export function currentRequestMeta(): RequestMeta {
  return storage.getStore() ?? { ip: null, userAgent: '' }
}

export const requestContext: RequestHandler = (req, _res, next) => {
  const meta: RequestMeta = {
    ip: req.ip ?? null,
    userAgent: (req.get('user-agent') ?? '').slice(0, MAX_USER_AGENT),
  }
  storage.run(meta, next)
}
