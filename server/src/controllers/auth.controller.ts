import type { Request, Response } from 'express'

import { authOf } from '../middleware/auth.js'
import { meView } from '../selectors/accounts.selectors.js'
import {
  login as loginService,
  REFRESH_LIFETIME_SECONDS,
  revokeRefresh,
  rotateRefresh,
} from '../services/auth.service.js'
import { loginBody } from '../validators/auth.validators.js'

export const REFRESH_COOKIE = 'agri_refresh'
const REFRESH_COOKIE_OPTIONS = {
  path: '/api/v1/auth/',
  httpOnly: true,
  secure: true, // browsers accept Secure cookies on http://localhost
  sameSite: 'lax',
} as const

function refreshCookieOf(req: Request): string | undefined {
  return (req.cookies as Record<string, string | undefined>)[REFRESH_COOKIE]
}

function setRefreshCookie(res: Response, refresh: string): void {
  res.cookie(REFRESH_COOKIE, refresh, {
    ...REFRESH_COOKIE_OPTIONS,
    maxAge: REFRESH_LIFETIME_SECONDS * 1000,
  })
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = loginBody.parse(req.body)
  const { user, tokens } = await loginService({ email, password, ip: req.ip ?? '' })
  setRefreshCookie(res, tokens.refresh)
  res.json({ access: tokens.access, user: await meView(user) })
}

export async function refresh(req: Request, res: Response): Promise<void> {
  try {
    const tokens = await rotateRefresh(refreshCookieOf(req) ?? '')
    setRefreshCookie(res, tokens.refresh)
    res.json({ access: tokens.access })
  } catch (error) {
    res.clearCookie(REFRESH_COOKIE, REFRESH_COOKIE_OPTIONS)
    throw error
  }
}

export async function logout(req: Request, res: Response): Promise<void> {
  await revokeRefresh(refreshCookieOf(req))
  res.clearCookie(REFRESH_COOKIE, REFRESH_COOKIE_OPTIONS)
  res.status(204).end()
}

export async function me(req: Request, res: Response): Promise<void> {
  res.json(await meView(authOf(req).user))
}
