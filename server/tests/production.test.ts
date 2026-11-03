/** What only production uses: serving the app, HTTPS, the database role and the generated docs. */
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import mongoose from 'mongoose'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { buildDataDictionary, personalFields } from '../src/lib/dataDictionary.js'
import { appRolePrivileges, AUDIT_COLLECTION, checkDbRole } from '../src/lib/dbRole.js'
import { spaCsp } from '../src/middleware/spa.js'
import { FARM_PERSONAL_FIELDS } from '../src/models/farm.models.js'
import '../src/models/index.js'
import { FARMER_PERSONAL_FIELDS } from '../src/models/registry.models.js'

const PUBLIC_ORIGIN = 'https://agri.example.test'
const collections = () => Object.values(mongoose.models).map((model) => model.collection.name)

describe('serving the built app', () => {
  let dir: string
  const INDEX = '<!doctype html><title>Synthetic app</title>'

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'agri-spa-'))
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'index.html'), INDEX)
    writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)')
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const app = () => createApp({ production: false, staticDir: dir })

  it('answers any page path with the app, under the page policy', async () => {
    for (const path of ['/', '/farmers', '/admin/crops/some-id']) {
      const response = await request(app()).get(path)
      expect(response.status, path).toBe(200)
      expect(response.text).toBe(INDEX)
      expect(response.headers['content-security-policy']).toContain("script-src 'self'")
      expect(response.headers['cache-control']).toBe('no-cache')
      expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
    }
  })

  it('caches built files for good', async () => {
    const response = await request(app()).get('/assets/app-abc123.js')
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toContain('immutable')
    expect(response.headers['content-security-policy']).toContain("script-src 'self'")
  })

  it('does not answer a missing file with the app', async () => {
    expect((await request(app()).get('/assets/gone.js')).status).toBe(404)
    expect((await request(app()).get('/favicon.ico')).status).toBe(404)
  })

  it('keeps API paths as API errors, under the strict policy', async () => {
    const response = await request(app()).get('/api/v1/not-a-route')
    expect(response.status).toBe(404)
    expect(response.type).toBe('application/json')
    expect(response.headers['content-security-policy']).toContain("default-src 'none'")
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['referrer-policy']).toBe('same-origin')
  })

  it('does not answer writes with the app', async () => {
    expect((await request(app()).post('/farmers')).status).toBe(404)
  })

  it('cannot be walked out of its folder', async () => {
    const response = await request(app()).get('/assets/..%2f..%2fsecret.txt')
    expect(response.text).not.toContain('secret')
    expect(response.status).toBe(404)
  })

  it('allows the map tile server, workers and nothing from elsewhere', () => {
    const csp = spaCsp('https://tiles.example.test/{z}/{x}/{y}.png')
    expect(csp).toContain("img-src 'self' data: blob: https://tiles.example.test")
    expect(csp).toContain("connect-src 'self' https://tiles.example.test")
    expect(csp).toContain("worker-src 'self' blob:")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toContain("script-src 'self' 'unsafe")
    expect(spaCsp('https://{s}.tiles.example.test/{z}.png')).toContain('connect-src')
  })

  it('does not serve the app unless told to', async () => {
    const response = await request(createApp({ production: false })).get('/farmers')
    expect(response.status).toBe(404)
  })
})

describe('HTTPS', () => {
  const app = () => createApp({ production: true, trustedProxies: 1, publicOrigin: PUBLIC_ORIGIN })

  it('sends plain page requests to the public address', async () => {
    const response = await request(app()).get('/farmers?page=2')
    expect(response.status).toBe(308)
    expect(response.headers.location).toBe(`${PUBLIC_ORIGIN}/farmers?page=2`)
  })

  it('cannot be made to redirect elsewhere', async () => {
    const response = await request(app())
      .get('//evil.example.test/')
      .set('Host', 'evil.example.test')
    expect(response.headers.location?.startsWith(`${PUBLIC_ORIGIN}/`)).toBe(true)
  })

  it('refuses a plain write, which has already crossed unencrypted', async () => {
    const response = await request(app())
      .post('/api/v1/auth/login')
      .send({ email: 'a', password: 'b' })
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ code: 'https_required' })
  })

  it('lets through what the proxy says arrived over HTTPS', async () => {
    const response = await request(app()).get('/api/v1/auth/me').set('X-Forwarded-Proto', 'https')
    expect(response.status).toBe(401)
    expect(response.headers['strict-transport-security']).toContain('max-age=')
  })

  it('ignores that claim when no proxy is trusted', async () => {
    const direct = createApp({ production: true, trustedProxies: 0, publicOrigin: PUBLIC_ORIGIN })
    const response = await request(direct).get('/farmers').set('X-Forwarded-Proto', 'https')
    expect(response.status).toBe(308)
  })

  it('leaves the health check open for the host to probe', async () => {
    const response = await request(app()).get('/api/health')
    expect(response.status).not.toBe(308)
  })
})

describe('the database role', () => {
  it('only lets the audit log be read and added to', () => {
    const privileges = appRolePrivileges('agri_prod', collections())
    expect(privileges).toHaveLength(new Set(collections()).size)
    const audit = privileges.find((row) => row.resource.collection === AUDIT_COLLECTION)
    expect(audit?.actions).toEqual(['find', 'insert'])
    for (const row of privileges) {
      expect(row.resource.db).toBe('agri_prod')
      expect(row.actions).not.toContain('dropCollection')
      if (row !== audit) expect(row.actions).toEqual(['find', 'insert', 'update', 'remove'])
    }
  })

  describe('on a database that enforces it', () => {
    const DB = 'agri_role_check'
    let replSet: MongoMemoryReplSet
    let root: MongoClient
    let app: MongoClient

    beforeAll(async () => {
      const rootPassword = randomUUID()
      replSet = await MongoMemoryReplSet.create({
        replSet: {
          count: 1,
          auth: { enable: true, customRootName: 'sampleroot', customRootPwd: rootPassword },
        },
      })
      const host = replSet.getUri().replace('mongodb://', '').split('/')[0] ?? ''
      const query = `authSource=admin&replicaSet=${replSet.replSetOpts.name ?? 'testset'}`
      root = await MongoClient.connect(`mongodb://sampleroot:${rootPassword}@${host}/?${query}`)
      const privileges = appRolePrivileges(DB, collections())
      await root.db('admin').command({ createRole: 'agriApp', privileges, roles: [] })
      const appPassword = randomUUID()
      await root.db('admin').command({
        createUser: 'sampleapp',
        pwd: appPassword,
        roles: [{ role: 'agriApp', db: 'admin' }],
      })
      for (const name of new Set(collections())) await root.db(DB).createCollection(name)
      await root
        .db(DB)
        .collection('programs')
        .insertOne({ _id: 'keep' } as never)
      await root
        .db(DB)
        .collection(AUDIT_COLLECTION)
        .insertOne({ _id: 'keep' } as never)
      app = await MongoClient.connect(`mongodb://sampleapp:${appPassword}@${host}/?${query}`)
    }, 120_000)

    afterAll(async () => {
      await app.close()
      await root.close()
      await replSet.stop()
    }, 60_000)

    it('passes the check for the application account, and leaves nothing behind', async () => {
      expect(await checkDbRole(app, app.db(DB), collections())).toEqual([])
      expect(await root.db(DB).collection('programs').countDocuments()).toBe(1)
      expect(await root.db(DB).collection(AUDIT_COLLECTION).countDocuments()).toBe(1)
    })

    it('stops the application changing, deleting or dropping the audit log', async () => {
      const audit = app.db(DB).collection(AUDIT_COLLECTION)
      const keep = { _id: 'keep' } as never
      await expect(audit.updateOne(keep, { $set: { after: 'changed' } })).rejects.toThrow(
        /not authorized/u,
      )
      await expect(audit.deleteOne(keep)).rejects.toThrow(/not authorized/u)
      await expect(audit.drop()).rejects.toThrow(/not authorized/u)
      await expect(audit.insertOne({ _id: 'added' } as never)).resolves.toBeTruthy()
      await expect(audit.findOne(keep)).resolves.toBeTruthy()
      await root
        .db(DB)
        .collection(AUDIT_COLLECTION)
        .deleteOne({ _id: 'added' } as never)
    })

    it('stops the application reaching other databases or creating indexes', async () => {
      await expect(app.db('other').collection('x').findOne({})).rejects.toThrow(/not authorized/u)
      await expect(app.db(DB).collection('programs').createIndex({ name: 1 })).rejects.toThrow(
        /not authorized/u,
      )
    })

    it('reports an administrator account as too powerful', async () => {
      const problems = await checkDbRole(root, root.db(DB), collections())
      expect(problems).toContain(`${AUDIT_COLLECTION}: can be changed, and must not be`)
      expect(problems).toContain(`${AUDIT_COLLECTION}: can be deleted from, and must not be`)
    })
  })
})

describe('the data dictionary', () => {
  it('is up to date with the models (npm run data-dictionary -w server)', () => {
    const built = buildDataDictionary(
      Object.values(mongoose.models),
      personalFields(FARMER_PERSONAL_FIELDS, FARM_PERSONAL_FIELDS),
    )
    const path = join(import.meta.dirname, '..', '..', 'docs', 'data-dictionary.md')
    expect(readFileSync(path, 'utf8').replaceAll('\r\n', '\n')).toBe(built)
  })
})
