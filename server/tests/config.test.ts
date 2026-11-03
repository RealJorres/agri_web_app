import { describe, expect, it } from 'vitest'

import { assertLocalDatabaseUri, connectDatabase } from '../src/config/database.js'
import { EnvError, parseEnv } from '../src/config/env.js'

const SECRET = 'S3cretPassw0rd'
const URI = `mongodb+srv://user:${SECRET}@cluster0.example.mongodb.net/`
const SIGNING_KEY = 'a'.repeat(50)

describe('parseEnv', () => {
  it('applies defaults, including a development database name', () => {
    const env = parseEnv({ MONGODB_URI: URI })
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: 8000,
      MONGODB_DB: 'agri_dev',
    })
  })

  it('names a missing connection string', () => {
    expect(() => parseEnv({})).toThrow(EnvError)
    expect(() => parseEnv({})).toThrow(/MONGODB_URI is required/)
  })

  it('never repeats a bad value in its message', () => {
    const attempt = () => parseEnv({ MONGODB_URI: `http://user:${SECRET}@example.com` })
    expect(attempt).toThrow(/MONGODB_URI must start with/)
    expect(attempt).not.toThrow(new RegExp(SECRET))
  })

  it('requires an explicit database name in production', () => {
    const production = {
      NODE_ENV: 'production',
      MONGODB_URI: URI,
      JWT_SIGNING_KEY: SIGNING_KEY,
      PUBLIC_ORIGIN: 'https://agri.example.test',
      TRUSTED_PROXY_COUNT: '1',
    }
    expect(() => parseEnv(production)).toThrow(/MONGODB_DB is required in production/)
    expect(parseEnv({ ...production, MONGODB_DB: 'agri_prod' }).MONGODB_DB).toBe('agri_prod')
  })

  it('requires a public HTTPS address and a proxy in production', () => {
    const settings = {
      NODE_ENV: 'production',
      MONGODB_URI: URI,
      MONGODB_DB: 'agri_prod',
      JWT_SIGNING_KEY: SIGNING_KEY,
    }
    const proxied = { ...settings, TRUSTED_PROXY_COUNT: '1' }
    const secure = { ...settings, PUBLIC_ORIGIN: 'https://agri.example.test' }
    expect(() => parseEnv(proxied)).toThrow(/PUBLIC_ORIGIN is required/)
    expect(() => parseEnv(secure)).toThrow(/TRUSTED_PROXY_COUNT must be at least 1/)
    expect(() => parseEnv({ ...proxied, PUBLIC_ORIGIN: 'http://agri.example.test' })).toThrow(
      /PUBLIC_ORIGIN must look like/,
    )
    expect(() => parseEnv({ ...proxied, PUBLIC_ORIGIN: 'https://agri.example.test/app' })).toThrow(
      /PUBLIC_ORIGIN must look like/,
    )
    expect(parseEnv({ ...proxied, PUBLIC_ORIGIN: 'https://agri.example.test' }).PUBLIC_ORIGIN).toBe(
      'https://agri.example.test',
    )
  })

  it.each([undefined, 'short', `insecure-${'a'.repeat(50)}`])(
    'requires a strong signing key in production (%#)',
    (key) => {
      const settings = { NODE_ENV: 'production', MONGODB_URI: URI, MONGODB_DB: 'agri_prod' }
      expect(() => parseEnv({ ...settings, JWT_SIGNING_KEY: key })).toThrow(
        /JWT_SIGNING_KEY must be/,
      )
    },
  )

  it('splits the trusted origins', () => {
    const env = parseEnv({
      MONGODB_URI: URI,
      CSRF_TRUSTED_ORIGINS: 'https://a.test, https://b.test',
    })
    expect(env.CSRF_TRUSTED_ORIGINS).toEqual(['https://a.test', 'https://b.test'])
  })
})

describe('tests cannot reach a hosted database', () => {
  it.each([
    URI,
    'mongodb://user:pw@cluster0.example.mongodb.net:27017/',
    'mongodb://127.0.0.1:27017,db.example.com:27017/?replicaSet=rs',
    'mongodb://127.0.0.1.example.com:27017/',
  ])('refuses a non-local URI (%#)', (uri) => {
    expect(() => {
      assertLocalDatabaseUri(uri)
    }).toThrow(/local database/)
  })

  it.each([
    'mongodb://127.0.0.1:27017/?replicaSet=testset',
    'mongodb://localhost:27017',
    'mongodb://[::1]:27017/db',
  ])('accepts a local URI (%#)', (uri) => {
    expect(() => {
      assertLocalDatabaseUri(uri)
    }).not.toThrow()
  })

  it('applies the guard when connecting, and does not leak the password', async () => {
    const attempt = connectDatabase(URI, 'agri_dev', { autoIndex: false })
    await expect(attempt).rejects.toThrow(/local database/)
    await expect(attempt).rejects.not.toThrow(new RegExp(SECRET))
  })
})
