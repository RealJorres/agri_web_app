import type { Express } from 'express'
import { SignJWT } from 'jose'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { jwtSigningKey } from '../src/config/env.js'
import { Role } from '../src/lib/roles.js'
import { RefreshToken, User } from '../src/models/account.models.js'
import { issueTokens, revokeAllTokens } from '../src/services/auth.service.js'
import {
  makeMunicipality,
  makeUser,
  signedIn,
  TEST_PASSWORD,
  userWithRole,
} from './support/factories.js'

const REFRESH_COOKIE = 'agri_refresh'
const ORIGIN = 'http://sample.test'
// A new app per client, because rate-limit counters belong to the app.
const newApp = () => createApp({ production: false, csrfTrustedOrigins: [ORIGIN] })
const app = newApp()

interface ErrorBody {
  code: string
  message: string
  fields: Record<string, string[]>
}

/**
 * Behaves like the frontend: gets a CSRF token, sends it back, and keeps cookies. It keeps the
 * refresh cookie by hand because the test client will not send a Secure cookie over plain HTTP.
 */
class Browser {
  csrf = ''
  refresh: string | undefined

  constructor(readonly target: Express = newApp()) {}

  async start(): Promise<this> {
    const response = await request(this.target).get('/api/v1/auth/csrf')
    this.csrf = (response.body as { csrf_token: string }).csrf_token
    return this
  }

  post(path: string, body?: object) {
    const cookies = [`csrftoken=${this.csrf}`]
    if (this.refresh) cookies.push(`${REFRESH_COOKIE}=${this.refresh}`)
    const pending = request(this.target)
      .post(`/api/v1/auth/${path}`)
      .set('Origin', ORIGIN)
      .set('X-CSRFToken', this.csrf)
      .set('Cookie', cookies.join('; '))
    return body ? pending.send(body) : pending
  }

  async login(email: string, password = TEST_PASSWORD) {
    const response = await this.post('login', { email, password })
    this.keepCookie(response.headers['set-cookie'])
    return response
  }

  async rotate() {
    const response = await this.post('refresh')
    this.keepCookie(response.headers['set-cookie'])
    return response
  }

  private keepCookie(header: unknown): void {
    const cookies = Array.isArray(header) ? (header as string[]) : []
    const line = cookies.find((cookie) => cookie.startsWith(`${REFRESH_COOKIE}=`))
    if (line) this.refresh = line.slice(REFRESH_COOKIE.length + 1).split(';')[0]
  }
}

function setCookieLine(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie']
  const cookies = Array.isArray(header) ? (header as string[]) : []
  return cookies.find((cookie) => cookie.startsWith(`${REFRESH_COOKIE}=`)) ?? ''
}

describe('login', () => {
  it('returns an access token and sets the refresh token only as a cookie', async () => {
    const gasan = await makeMunicipality()
    const user = await userWithRole(Role.MAO_VALIDATOR, { municipalityId: gasan._id })
    const browser = await new Browser().start()

    const response = await browser.login(user.email)

    expect(response.status).toBe(200)
    const body = response.body as {
      access: string
      refresh?: string
      user: { roles: string[]; assignments: { municipality: { name: string } }[] }
    }
    expect(body.access).toBeTruthy()
    expect(body.refresh).toBeUndefined()
    expect(body.user.roles).toEqual(['mao_validator'])
    expect(body.user.assignments[0]?.municipality.name).toBe(gasan.name)
    const cookie = setCookieLine(response)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/api/v1/auth/')
    expect(cookie).toContain(`Max-Age=${7 * 24 * 3600}`)
  })

  it('ignores case and surrounding spaces in the email', async () => {
    const user = await makeUser()
    const browser = await new Browser().start()
    const response = await browser.login(`  ${user.email.toUpperCase()}`)
    expect(response.status).toBe(200)
  })

  it('uses the error contract for a wrong password, and sets no cookie', async () => {
    const user = await makeUser()
    const browser = await new Browser().start()
    const response = await browser.login(user.email, 'wrong-password')
    expect(response.status).toBe(401)
    expect(response.body).toEqual({
      code: 'invalid_credentials',
      message: 'Email or password is incorrect.',
      fields: {},
    })
    expect(setCookieLine(response)).toBe('')
  })

  it('gives the same answer for an unknown email', async () => {
    const browser = await new Browser().start()
    const response = await browser.login('nobody@example.test')
    expect(response.status).toBe(401)
    expect((response.body as ErrorBody).code).toBe('invalid_credentials')
  })

  it('rejects an inactive user', async () => {
    const user = await makeUser({ isActive: false })
    const browser = await new Browser().start()
    expect((await browser.login(user.email)).status).toBe(401)
  })

  it('reports a malformed email as a field error', async () => {
    const browser = await new Browser().start()
    const response = await browser.login('not-an-email')
    expect(response.status).toBe(400)
    expect(Object.keys((response.body as ErrorBody).fields)).toEqual(['email'])
  })

  it('records the last sign-in time', async () => {
    const user = await makeUser()
    const browser = await new Browser().start()
    await browser.login(user.email)
    expect((await User.findById(user._id).lean())?.lastLoginAt).toBeInstanceOf(Date)
  })
})

describe('CSRF', () => {
  it('refuses a login with no token', async () => {
    const user = await makeUser()
    const response = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: user.email, password: TEST_PASSWORD })
    expect(response.status).toBe(403)
    expect((response.body as ErrorBody).code).toBe('permission_denied')
  })

  it('refuses a token that differs from the cookie', async () => {
    const browser = await new Browser().start()
    const response = await browser.post('login', {}).set('X-CSRFToken', 'other')
    expect(response.status).toBe(403)
  })

  it('refuses a foreign origin even with a good token', async () => {
    const user = await makeUser()
    const browser = await new Browser().start()
    const response = await browser
      .post('login', { email: user.email, password: TEST_PASSWORD })
      .set('Origin', 'https://evil.example')
    expect(response.status).toBe(403)
  })

  it('refuses a refresh with no CSRF header', async () => {
    const user = await makeUser()
    const browser = await new Browser().start()
    await browser.login(user.email)
    const response = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Origin', ORIGIN)
      .set('Cookie', `csrftoken=${browser.csrf}; ${REFRESH_COOKIE}=${browser.refresh ?? ''}`)
    expect(response.status).toBe(403)
  })

  it('accepts the same origin the server is on, with no extra setting', async () => {
    const plain = createApp({ production: false })
    const browser = await new Browser(plain).start()
    const response = await request(plain)
      .post('/api/v1/auth/logout')
      .set('Host', 'sample.test')
      .set('Origin', 'http://sample.test')
      .set('X-CSRFToken', browser.csrf)
      .set('Cookie', `csrftoken=${browser.csrf}`)
    expect(response.status).toBe(204)
  })
})

describe('lockout and throttling', () => {
  it('locks an email and address after five failures, even with the right password', async () => {
    const user = await makeUser()
    const browser = await new Browser(
      createApp({ production: false, csrfTrustedOrigins: [ORIGIN] }),
    ).start()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await browser.login(user.email, 'wrong-password')
    }
    const response = await browser.login(user.email)
    expect(response.status).toBe(429)
    expect((response.body as ErrorBody).code).toBe('locked_out')
  })

  it('clears the failures after a successful sign-in', async () => {
    const user = await makeUser()
    const browser = await new Browser(
      createApp({ production: false, csrfTrustedOrigins: [ORIGIN] }),
    ).start()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await browser.login(user.email, 'wrong-password')
    }
    expect((await browser.login(user.email)).status).toBe(200)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await browser.login(user.email, 'wrong-password')
    }
    expect((await browser.login(user.email)).status).toBe(200)
  })

  it('throttles sign-in attempts per address', async () => {
    const browser = await new Browser(
      createApp({ production: false, csrfTrustedOrigins: [ORIGIN] }),
    ).start()
    const statuses: number[] = []
    for (let attempt = 0; attempt < 11; attempt += 1) {
      statuses.push((await browser.login(`user${attempt}@example.test`)).status)
    }
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true)
    expect(statuses[10]).toBe(429)
  })
})

describe('refresh', () => {
  it('rotates the token and revokes the old one', async () => {
    const user = await makeUser()
    const browser = await new Browser().start()
    await browser.login(user.email)
    const first = browser.refresh

    const response = await browser.rotate()

    expect(response.status).toBe(200)
    expect((response.body as { access: string }).access).toBeTruthy()
    expect(browser.refresh).not.toBe(first)
    expect(await RefreshToken.countDocuments({ userId: user._id, revokedAt: null })).toBe(1)
    expect(await RefreshToken.countDocuments({ userId: user._id })).toBe(2)
  })

  it('revokes every session when a used token comes back', async () => {
    const user = await makeUser()
    const browser = await new Browser().start()
    await browser.login(user.email)
    const stolen = browser.refresh
    await browser.rotate()
    const current = browser.refresh

    browser.refresh = stolen
    const reuse = await browser.post('refresh')

    expect(reuse.status).toBe(401)
    expect(setCookieLine(reuse)).toContain(`${REFRESH_COOKIE}=;`)
    expect(await RefreshToken.countDocuments({ userId: user._id, revokedAt: null })).toBe(0)
    browser.refresh = current
    expect((await browser.post('refresh')).status).toBe(401)
  })

  it('lets only one of two simultaneous requests use a token', async () => {
    const user = await makeUser()
    const browser = await new Browser().start()
    await browser.login(user.email)
    const results = await Promise.all([browser.post('refresh'), browser.post('refresh')])
    expect(results.filter((response) => response.status === 200)).toHaveLength(1)
  })

  it('answers 401 with no cookie, or a bad one', async () => {
    const browser = await new Browser().start()
    const missing = await browser.post('refresh')
    expect(missing.status).toBe(401)
    expect((missing.body as ErrorBody).code).toBe('token_invalid')
    browser.refresh = 'not-a-jwt'
    expect((await browser.post('refresh')).status).toBe(401)
  })

  it('does not treat an access token as a refresh token', async () => {
    const user = await makeUser()
    const browser = await new Browser().start()
    browser.refresh = (await issueTokens(user._id)).access
    expect((await browser.post('refresh')).status).toBe(401)
  })

  it('fails once the user is deactivated', async () => {
    const user = await makeUser()
    const browser = await new Browser().start()
    await browser.login(user.email)
    await User.updateOne({ _id: user._id }, { $set: { isActive: false } })
    expect((await browser.post('refresh')).status).toBe(401)
  })
})

describe('logout', () => {
  it('revokes the refresh token and clears the cookie', async () => {
    const user = await makeUser()
    const browser = await new Browser().start()
    await browser.login(user.email)
    const response = await browser.post('logout')
    expect(response.status).toBe(204)
    expect(setCookieLine(response)).toContain(`${REFRESH_COOKIE}=;`)
    expect(await RefreshToken.countDocuments({ userId: user._id, revokedAt: null })).toBe(0)
  })

  it('is harmless without a session', async () => {
    const browser = await new Browser().start()
    expect((await browser.post('logout')).status).toBe(204)
  })
})

describe('access tokens and /auth/me', () => {
  it('authenticates with an access token and reports capabilities', async () => {
    const boac = await makeMunicipality()
    const user = await userWithRole(Role.FIELD_ENCODER, { municipalityId: boac._id })
    const response = await signedIn(request(app).get('/api/v1/auth/me'), user)
    expect(response.status).toBe(200)
    const body = response.body as { email: string; capabilities: string[] }
    expect(body.email).toBe(user.email)
    expect(body.capabilities).toContain('edit_records')
    expect(body.capabilities).not.toContain('approve')
  })

  it('requires authentication', async () => {
    const response = await request(app).get('/api/v1/auth/me')
    expect(response.status).toBe(401)
    expect((response.body as ErrorBody).code).toBe('not_authenticated')
  })

  it('treats a superuser as system admin', async () => {
    const admin = await makeUser({ isSuperuser: true })
    const response = await signedIn(request(app).get('/api/v1/auth/me'), admin)
    const body = response.body as { roles: string[]; capabilities: string[] }
    expect(body.roles).toEqual(['system_admin'])
    expect(body.capabilities).toContain('admin')
  })

  it('refuses a token for a deactivated user, a forged token and a refresh token', async () => {
    const user = await makeUser()
    const { access, refresh } = await issueTokens(user._id)
    const me = (token: string) =>
      request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)

    expect((await me(refresh)).status).toBe(401)
    const forged = await new SignJWT({ token_type: 'access', user_id: user._id })
      .setProtectedHeader({ alg: 'HS256' })
      .setJti('forged')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('some-other-key-some-other-key-some-other-key'))
    expect((await me(forged)).status).toBe(401)
    const expired = await new SignJWT({ token_type: 'access', user_id: user._id })
      .setProtectedHeader({ alg: 'HS256' })
      .setJti('expired')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(jwtSigningKey())
    expect((await me(expired)).status).toBe(401)
    await User.updateOne({ _id: user._id }, { $set: { isActive: false } })
    expect((await me(access)).status).toBe(401)
  })
})

describe('revokeAllTokens', () => {
  it('counts only live tokens', async () => {
    const user = await makeUser()
    await issueTokens(user._id)
    await issueTokens(user._id)
    expect(await revokeAllTokens(user._id)).toBe(2)
    expect(await revokeAllTokens(user._id)).toBe(0)
  })
})
