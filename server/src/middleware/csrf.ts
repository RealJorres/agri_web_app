import { randomBytes, timingSafeEqual } from 'node:crypto'

import type { Request, RequestHandler } from 'express'

import { DomainError } from '../lib/errors.js'

export const CSRF_COOKIE = 'csrftoken'
const CSRF_HEADER = 'x-csrftoken'
const ONE_YEAR_MS = 365 * 24 * 3600 * 1000

function denied(reason: string): DomainError {
  return new DomainError('permission_denied', `CSRF failed: ${reason}`, {}, 403)
}

function sameValue(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

function comesFromAllowedOrigin(req: Request, trustedOrigins: readonly string[]): boolean {
  const allowed = new Set([`${req.protocol}://${req.get('host') ?? ''}`, ...trustedOrigins])
  const origin = req.get('origin')
  if (origin !== undefined) return allowed.has(originOf(origin) ?? '')
  // Browsers may leave out Origin. Over HTTPS the Referer must then prove where the request began.
  if (!req.secure) return true
  const referer = req.get('referer')
  return referer !== undefined && allowed.has(originOf(referer) ?? '')
}

/** Guards the endpoints that read the refresh cookie: double-submit token plus an origin check. */
export function enforceCsrf(trustedOrigins: readonly string[]): RequestHandler {
  return (req, _res, next) => {
    if (!comesFromAllowedOrigin(req, trustedOrigins)) throw denied('origin not allowed')
    const cookies = req.cookies as Record<string, string | undefined>
    const cookie = cookies[CSRF_COOKIE]
    const header = req.get(CSRF_HEADER)
    if (!cookie || !header || !sameValue(cookie, header)) throw denied('token missing or wrong')
    next()
  }
}

/** Sets the readable cookie the frontend echoes back as a header, and returns the same value. */
export function issueCsrfToken({ production }: { production: boolean }): RequestHandler {
  return (req, res) => {
    const cookies = req.cookies as Record<string, string | undefined>
    const token = cookies[CSRF_COOKIE] ?? randomBytes(32).toString('hex')
    res.cookie(CSRF_COOKIE, token, {
      maxAge: ONE_YEAR_MS,
      path: '/',
      sameSite: 'lax',
      secure: production,
    })
    res.json({ csrf_token: token })
  }
}
