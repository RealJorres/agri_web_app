import mongoose from 'mongoose'
import request from 'supertest'
import { describe, expect, inject, it } from 'vitest'

import { createApp } from '../src/app.js'
import { connectDatabase, disconnectDatabase } from '../src/config/database.js'

const app = createApp({ production: false })

describe('GET /api/health', () => {
  it('reports ok while the database answers', async () => {
    const response = await request(app).get('/api/health')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: 'ok', checks: { database: 'ok' } })
  })

  it('reports 503 and no details when the database is away', async () => {
    const { name } = mongoose.connection
    await disconnectDatabase()
    try {
      const response = await request(app).get('/api/health')
      expect(response.status).toBe(503)
      expect(response.body).toEqual({ status: 'degraded', checks: { database: 'down' } })
    } finally {
      await connectDatabase(inject('mongoUri'), name, { autoIndex: true })
    }
  })
})

describe('transactions', () => {
  it('are available and roll back, which the audit rule depends on', async () => {
    const collection = mongoose.connection.collection<{ _id: string }>('transaction_check')
    const session = await mongoose.startSession()
    await expect(
      session.withTransaction(async () => {
        await collection.insertOne({ _id: 'synthetic' }, { session })
        throw new Error('roll back')
      }),
    ).rejects.toThrow('roll back')
    await session.endSession()
    expect(await collection.countDocuments()).toBe(0)
  })
})
