import { createHash, randomUUID } from 'node:crypto'

import { errors as joseErrors, jwtVerify, SignJWT } from 'jose'

import { jwtSigningKey } from '../config/env.js'
import { DomainError } from '../lib/errors.js'
import { verifyPassword } from '../lib/passwords.js'
import { LoginAttempt, RefreshToken, User, type UserDoc } from '../models/account.models.js'

const ACCESS_LIFETIME_SECONDS = 15 * 60
export const REFRESH_LIFETIME_SECONDS = 7 * 24 * 3600
const FAILURE_LIMIT = 5
const COOL_OFF_MS = 15 * 60 * 1000
const DUPLICATE_KEY = 11000

type TokenType = 'access' | 'refresh'

export interface TokenPair {
  access: string
  refresh: string
}

interface TokenClaims {
  userId: string
  jti: string
}

function invalidToken(): DomainError {
  return new DomainError('token_invalid', 'Session expired. Please sign in again.', {}, 401)
}

function lockedOut(): DomainError {
  return new DomainError(
    'locked_out',
    'Too many failed sign-in attempts. Try again later.',
    {},
    429,
  )
}

async function signToken(
  type: TokenType,
  userId: string,
  jti: string,
  lifetimeSeconds: number,
): Promise<string> {
  return new SignJWT({ token_type: type, user_id: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(`${lifetimeSeconds}s`)
    .sign(jwtSigningKey())
}

/** The claims of a valid token of this type, or null when it is forged, expired or malformed. */
async function readToken(raw: string, type: TokenType): Promise<TokenClaims | null> {
  try {
    const { payload } = await jwtVerify(raw, jwtSigningKey(), { algorithms: ['HS256'] })
    const { token_type: tokenType, user_id: userId, jti } = payload
    if (tokenType !== type || typeof userId !== 'string' || typeof jti !== 'string') return null
    return { userId, jti }
  } catch (error) {
    if (error instanceof joseErrors.JOSEError) return null
    throw error
  }
}

export async function readAccessToken(raw: string): Promise<string | null> {
  return (await readToken(raw, 'access'))?.userId ?? null
}

export async function issueTokens(userId: string): Promise<TokenPair> {
  const jti = randomUUID()
  await RefreshToken.create({
    _id: jti,
    userId,
    expiresAt: new Date(Date.now() + REFRESH_LIFETIME_SECONDS * 1000),
  })
  return {
    access: await signToken('access', userId, randomUUID(), ACCESS_LIFETIME_SECONDS),
    refresh: await signToken('refresh', userId, jti, REFRESH_LIFETIME_SECONDS),
  }
}

function attemptKey(email: string, ip: string): string {
  return createHash('sha256').update(`${email}|${ip}`).digest('hex')
}

async function isLockedOut(key: string): Promise<boolean> {
  const attempt = await LoginAttempt.findOne({ _id: key, expiresAt: { $gt: new Date() } }).lean()
  return attempt !== null && attempt.failures >= FAILURE_LIMIT
}

/** Counts a failure and returns the new total. An expired count starts again from one. */
async function recordFailure(key: string, retry = true): Promise<number> {
  const now = new Date()
  try {
    const attempt = await LoginAttempt.collection.findOneAndUpdate(
      { _id: key as never },
      [
        {
          $set: {
            failures: {
              $cond: [
                { $gt: ['$expiresAt', now] },
                { $add: [{ $ifNull: ['$failures', 0] }, 1] },
                1,
              ],
            },
            expiresAt: new Date(now.getTime() + COOL_OFF_MS),
          },
        },
      ],
      { upsert: true, returnDocument: 'after' },
    )
    return (attempt?.failures as number | undefined) ?? 1
  } catch (error) {
    // Two failures at once can both try to create the document; the second then updates it.
    if (retry && (error as { code?: unknown }).code === DUPLICATE_KEY) {
      return recordFailure(key, false)
    }
    throw error
  }
}

export async function login(input: {
  email: string
  password: string
  ip: string
}): Promise<{ user: UserDoc; tokens: TokenPair }> {
  const email = input.email.trim().toLowerCase()
  const key = attemptKey(email, input.ip)
  if (await isLockedOut(key)) throw lockedOut()

  const user = await User.findOne({ email }).lean()
  const matched = await verifyPassword(user?.passwordHash ?? null, input.password)
  if (!user || !matched || !user.isActive) {
    const failures = await recordFailure(key)
    if (failures >= FAILURE_LIMIT) throw lockedOut()
    throw new DomainError('invalid_credentials', 'Email or password is incorrect.', {}, 401)
  }

  await LoginAttempt.deleteOne({ _id: key })
  const lastLoginAt = new Date()
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt } })
  return { user: { ...user, lastLoginAt }, tokens: await issueTokens(user._id) }
}

/** Revokes every live refresh token of the user and returns how many there were. */
export async function revokeAllTokens(userId: string): Promise<number> {
  const result = await RefreshToken.updateMany(
    { userId, revokedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { revokedAt: new Date() } },
  )
  return result.modifiedCount
}

/**
 * Refresh tokens are single use. Presenting one that was already used means it may have been
 * stolen, so that revokes every session the user has. Claiming the token is one atomic update, so
 * two concurrent requests cannot both succeed.
 */
export async function rotateRefresh(raw: string): Promise<TokenPair> {
  const claims = await readToken(raw, 'refresh')
  if (!claims) throw invalidToken()

  const claimed = await RefreshToken.findOneAndUpdate(
    { _id: claims.jti, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  ).lean()
  if (!claimed) {
    if (await RefreshToken.exists({ _id: claims.jti })) await revokeAllTokens(claims.userId)
    throw invalidToken()
  }

  const user = await User.findOne({ _id: claims.userId, isActive: true }).lean()
  if (!user) throw invalidToken()
  return issueTokens(user._id)
}

export async function revokeRefresh(raw: string | undefined): Promise<void> {
  if (!raw) return
  const claims = await readToken(raw, 'refresh')
  if (!claims) return // already invalid: nothing to revoke
  await RefreshToken.updateOne(
    { _id: claims.jti, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  )
}
