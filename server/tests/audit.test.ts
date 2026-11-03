import type { Request, Response } from 'express'
import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { pageOf, pageRequest } from '../src/lib/pagination.js'
import { currentRequestMeta, requestContext } from '../src/lib/requestContext.js'
import { inTransaction } from '../src/lib/transaction.js'
import { errorHandler } from '../src/middleware/errorHandler.js'
import { AppendOnlyError, AuditLog } from '../src/models/auditLog.model.js'
import { auditTrail } from '../src/selectors/audit.selectors.js'
import { changes, mask, recordAudit, REDACTED } from '../src/services/audit.service.js'
import { makeUser } from './support/factories.js'

function entryFor(objectId: string) {
  return inTransaction((session) =>
    recordAudit({ actorId: null, action: 'test.action', objectType: 'x', objectId, session }),
  )
}

describe('append-only', () => {
  it('refuses every way of changing or deleting an entry', async () => {
    await entryFor('append-only')
    const entry = await AuditLog.findOne({ objectId: 'append-only' })
    if (!entry) throw new Error('entry missing')
    const filter = { _id: entry._id }
    const tamper = { action: 'tampered' }

    entry.action = 'tampered'
    await expect(entry.save()).rejects.toThrow(AppendOnlyError)
    await expect(entry.deleteOne()).rejects.toThrow(AppendOnlyError)
    await expect(AuditLog.updateOne(filter, tamper)).rejects.toThrow(AppendOnlyError)
    await expect(AuditLog.updateMany(filter, tamper)).rejects.toThrow(AppendOnlyError)
    await expect(AuditLog.findOneAndUpdate(filter, tamper)).rejects.toThrow(AppendOnlyError)
    await expect(AuditLog.replaceOne(filter, tamper)).rejects.toThrow(AppendOnlyError)
    await expect(AuditLog.deleteOne(filter)).rejects.toThrow(AppendOnlyError)
    await expect(AuditLog.deleteMany(filter)).rejects.toThrow(AppendOnlyError)
    await expect(AuditLog.findOneAndDelete(filter)).rejects.toThrow(AppendOnlyError)

    expect((await AuditLog.findById(entry._id).lean())?.action).toBe('test.action')
  })
})

describe('transactions', () => {
  it('rolls the audit entry back with the change', async () => {
    await expect(
      inTransaction(async (session) => {
        await recordAudit({
          actorId: null,
          action: 'test.rollback',
          objectType: 'x',
          objectId: 'rolled-back',
          session,
        })
        throw new Error('the change failed')
      }),
    ).rejects.toThrow('the change failed')
    expect(await AuditLog.countDocuments({ objectId: 'rolled-back' })).toBe(0)
  })
})

describe('masking', () => {
  it('hides personal values and keeps empty ones empty', () => {
    expect(
      mask({ firstName: 'Synthetic', contactNo: '09170000000', status: 'active', rsbsaNo: '' }, [
        'firstName',
        'contactNo',
        'rsbsaNo',
      ]),
    ).toEqual({ firstName: REDACTED, contactNo: REDACTED, status: 'active', rsbsaNo: null })
  })

  it('shows that a personal field changed without revealing it', () => {
    const result = changes(
      { contactNo: '0917-000-0001', status: 'active' },
      { contactNo: '0917-000-0002', status: 'active' },
      ['contactNo'],
    )
    expect(result).toEqual({ before: { contactNo: REDACTED }, after: { contactNo: REDACTED } })
    expect(JSON.stringify(result)).not.toContain('0917')
  })

  it('ignores unchanged fields, including equal lists', () => {
    expect(changes({ a: 1, b: 2, c: ['x'] }, { a: 1, b: 3, c: ['x'] })).toEqual({
      before: { b: 2 },
      after: { b: 3 },
    })
  })
})

describe('request details', () => {
  it('records the address and user agent, and has none outside a request', async () => {
    const app = express()
    app.use(requestContext)
    app.get('/', async (_req, res) => {
      await entryFor('with-meta')
      res.json(currentRequestMeta())
    })
    const response = await request(app).get('/').set('User-Agent', 'x'.repeat(400))
    const entry = await AuditLog.findOne({ objectId: 'with-meta' }).lean()
    expect(entry?.ip).toBeTruthy()
    expect(entry?.userAgent).toHaveLength(300)
    expect((response.body as { ip: string }).ip).toBe(entry?.ip)
    expect(currentRequestMeta()).toEqual({ ip: null, userAgent: '' })
  })
})

describe('auditTrail', () => {
  const trailApp = express()
  trailApp.get('/trail/:id', async (req: Request, res: Response) => {
    const page = pageRequest(req)
    const { count, results } = await auditTrail('x', String(req.params.id), page)
    res.json(pageOf(req, page, count, results))
  })
  trailApp.use(errorHandler)

  it('returns entries newest first, with the actor name, in the list envelope', async () => {
    const actor = await makeUser()
    for (const action of ['first', 'second', 'third']) {
      await inTransaction((session) =>
        recordAudit({ actorId: actor._id, action, objectType: 'x', objectId: 'trail', session }),
      )
    }
    const response = await request(trailApp).get('/trail/trail?page_size=2')
    const body = response.body as {
      count: number
      next: string
      previous: null
      results: { action: string; actor: string }[]
    }
    expect(body.count).toBe(3)
    expect(body.results.map((row) => row.action)).toEqual(['third', 'second'])
    expect(body.results[0]?.actor).toBe(`${actor.firstName} ${actor.lastName}`)
    expect(body.next).toContain('page=2')
    expect(body.previous).toBeNull()

    const second = await request(trailApp).get('/trail/trail?page_size=2&page=2')
    expect((second.body as { next: null; previous: string }).next).toBeNull()
    expect((second.body as { next: null; previous: string }).previous).toContain('page=1')
  })

  it('answers 404 for a page past the end or a bad page', async () => {
    await entryFor('short')
    expect((await request(trailApp).get('/trail/short?page=2')).status).toBe(404)
    expect((await request(trailApp).get('/trail/short?page=abc')).status).toBe(404)
  })
})
