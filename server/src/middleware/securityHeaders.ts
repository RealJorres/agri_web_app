import type { RequestHandler } from 'express'
import helmet from 'helmet'

// API responses never need to run scripts, load resources or be framed.
const API_CSP = {
  defaultSrc: ["'none'"],
  frameAncestors: ["'none'"],
  baseUri: ["'none'"],
  formAction: ["'none'"],
}
const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'

export function securityHeaders({ production }: { production: boolean }): RequestHandler[] {
  return [
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: API_CSP },
      frameguard: { action: 'deny' },
      referrerPolicy: { policy: 'same-origin' },
      // Browsers remember HSTS for a year, so it is only sent where HTTPS is permanent.
      strictTransportSecurity: production ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
    (_req, res, next) => {
      res.setHeader('Permissions-Policy', PERMISSIONS_POLICY)
      res.setHeader('Cache-Control', 'no-store') // responses may hold personal data
      next()
    },
  ]
}
