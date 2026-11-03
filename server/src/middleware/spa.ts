import { extname, join } from 'node:path'

import express, { Router, type RequestHandler } from 'express'

import { DomainError } from '../lib/errors.js'

const ONE_YEAR_SECONDS = 31_536_000

/** The tile server's origin, or any HTTPS host when the template makes the host unknowable. */
function tileOrigin(tileUrl: string): string {
  try {
    return new URL(tileUrl).origin
  } catch {
    return 'https:'
  }
}

/** The page needs more than the API does: its own code, the map's tiles and its blob workers. */
export function spaCsp(tileUrl: string): string {
  const tiles = tileOrigin(tileUrl)
  return [
    "default-src 'self'",
    "script-src 'self'",
    // MapLibre and the charts set style attributes, which CSP treats as inline style.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${tiles}`,
    `connect-src 'self' ${tiles}`,
    "font-src 'self'",
    // MapLibre loads its worker from our own built files.
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}

/** Serves the built frontend. Unknown page paths get the app, since React Router owns them. */
export function serveSpa(dir: string, tileUrl: string): Router {
  const csp = spaCsp(tileUrl)
  const router = Router()
  // Everything else here is for pages, so API paths and writes keep the API's own headers.
  router.use((req, _res, next) => {
    const isRead = req.method === 'GET' || req.method === 'HEAD'
    next(isRead && !req.path.startsWith('/api') ? undefined : 'router')
  })
  const pageHeaders: RequestHandler = (_req, res, next) => {
    res.setHeader('Content-Security-Policy', csp)
    // OpenStreetMap refuses tile requests with no referrer. This sends only our address, so paths
    // and record ids stay private.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    // The page itself is checked each time, so a new release shows at once.
    res.setHeader('Cache-Control', 'no-cache')
    next()
  }
  router.use(
    '/assets',
    pageHeaders,
    express.static(join(dir, 'assets'), {
      index: false,
      // Built file names contain a hash of their content, so they never change.
      setHeaders: (res) => {
        res.setHeader('Cache-Control', `public, max-age=${String(ONE_YEAR_SECONDS)}, immutable`)
      },
    }),
  )
  router.use(pageHeaders, express.static(dir, { index: false }))
  router.use((req, res, next) => {
    if (extname(req.path) !== '') {
      next()
      return
    }
    res.sendFile(join(dir, 'index.html'))
  })
  return router
}

/**
 * Behind a proxy that ends TLS, this sends plain HTTP to the public address. A write is refused
 * rather than redirected, because its body has already crossed the network unencrypted. The health
 * check is exempt, so that a host's own probe works.
 */
export function requireHttps(publicOrigin: string): RequestHandler {
  return (req, res, next) => {
    if (req.secure || req.path === '/api/health') {
      next()
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      res.redirect(308, `${publicOrigin}${req.originalUrl}`)
    } else {
      next(new DomainError('https_required', 'This address only accepts HTTPS.', {}, 400))
    }
  }
}
