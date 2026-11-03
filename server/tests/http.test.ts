import express, { type Express } from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { createApp } from '../src/app.js'
import { DomainError } from '../src/lib/errors.js'
import { logger } from '../src/lib/logger.js'
import { errorHandler } from '../src/middleware/errorHandler.js'

const app = createApp({ production: false })

/** An app whose only route throws the given error, using the real error handler. */
function appThrowing(error: unknown): Express {
  const throwing = express()
  throwing.get('/boom', () => {
    throw error
  })
  throwing.use(errorHandler)
  return throwing
}

describe('error contract', () => {
  it('renders an unknown route as a 404 with {code, message, fields}', async () => {
    const response = await request(app).get('/api/v1/nothing-here')
    expect(response.status).toBe(404)
    expect(response.body).toEqual({ code: 'not_found', message: 'Not found.', fields: {} })
  })

  it('renders malformed JSON as a 400', async () => {
    const response = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send('{not json')
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ code: 'parse_error', fields: {} })
  })

  it('renders an oversized body as a 413', async () => {
    const response = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ padding: 'x'.repeat(11 * 1024 * 1024) }))
    expect(response.status).toBe(413)
    expect(response.body).toMatchObject({ code: 'payload_too_large', fields: {} })
  })

  it('renders a DomainError with its own code, fields and status', async () => {
    const error = new DomainError('rule_broken', 'Not allowed.', { area: ['Too large.'] }, 409)
    const response = await request(appThrowing(error)).get('/boom')
    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      code: 'rule_broken',
      message: 'Not allowed.',
      fields: { area: ['Too large.'] },
    })
  })

  it('flattens validation errors to dotted field paths', async () => {
    const parsed = z.object({ stages: z.array(z.object({ count: z.number() })) }).safeParse({
      stages: [{ count: 'many' }],
    })
    const response = await request(appThrowing(parsed.error)).get('/boom')
    expect(response.status).toBe(400)
    const body = response.body as { code: string; fields: Record<string, string[]> }
    expect(body.code).toBe('validation_error')
    expect(Object.keys(body.fields)).toEqual(['stages.0.count'])
  })

  it('hides the cause of a server error from the client and from the log', async () => {
    const logged = vi.spyOn(logger, 'error')
    const error = new Error('E11000 duplicate key: Sample Farmer')
    const response = await request(appThrowing(error)).get('/boom')
    expect(response.status).toBe(500)
    expect(response.body).toEqual({
      code: 'server_error',
      message: 'Something went wrong on the server.',
      fields: {},
    })
    expect(JSON.stringify(logged.mock.calls)).not.toContain('Sample Farmer')
    expect(JSON.stringify(logged.mock.calls)).toContain('frames')
    logged.mockRestore()
  })
})

describe('security headers', () => {
  it('locks down API responses', async () => {
    const { headers } = await request(app).get('/api/health')
    expect(headers['content-security-policy']).toBe(
      "default-src 'none';frame-ancestors 'none';base-uri 'none';form-action 'none'",
    )
    expect(headers['cache-control']).toBe('no-store')
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['referrer-policy']).toBe('same-origin')
    expect(headers['permissions-policy']).toContain('geolocation=()')
    expect(headers['x-powered-by']).toBeUndefined()
  })

  it('sends HSTS only in production', async () => {
    const development = await request(app).get('/api/health')
    expect(development.headers['strict-transport-security']).toBeUndefined()
    const production = await request(createApp({ production: true })).get('/api/health')
    expect(production.headers['strict-transport-security']).toContain('max-age=31536000')
  })
})
