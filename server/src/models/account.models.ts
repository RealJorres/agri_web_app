import { randomUUID } from 'node:crypto'

import { model, Schema } from 'mongoose'

import { ALL_ROLES, type Role } from '../lib/roles.js'
import { baseFields, baseOptions, softDelete, uniqueAmongAlive, type BaseDoc } from './base.js'

/** A staff account. Logs in with email; roles and scope come from assignments. */
export interface UserDoc {
  _id: string
  email: string
  passwordHash: string
  firstName: string
  lastName: string
  isActive: boolean
  isSuperuser: boolean
  lastLoginAt: Date | null
  createdAt: Date
  updatedAt: Date
}

const userSchema = new Schema<UserDoc>(
  {
    _id: { type: String, default: () => randomUUID() },
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    firstName: { type: String, default: '' },
    lastName: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    isSuperuser: { type: Boolean, default: false },
    lastLoginAt: { type: Date, default: null },
  },
  { ...baseOptions, collection: 'users' },
)
userSchema.index({ email: 1 }, { unique: true })

export const User = model<UserDoc>('User', userSchema)

/** One role within one scope. A null municipality or program means "all". */
export interface UserAssignmentDoc extends BaseDoc {
  userId: string
  role: Role
  municipalityId: string | null
  programId: string | null
  /** Optional narrowing for field encoders; must belong to the municipality. */
  barangayIds: string[]
}

const assignmentSchema = new Schema<UserAssignmentDoc>(
  {
    ...baseFields,
    userId: { type: String, required: true },
    role: { type: String, required: true, enum: ALL_ROLES },
    municipalityId: { type: String, default: null },
    programId: { type: String, default: null },
    barangayIds: { type: [String], default: [] },
  },
  { ...baseOptions, collection: 'user_assignments' },
)
assignmentSchema.plugin(softDelete)
assignmentSchema.index({ userId: 1, role: 1, municipalityId: 1, programId: 1 }, uniqueAmongAlive)

export const UserAssignment = model<UserAssignmentDoc>('UserAssignment', assignmentSchema)

/** One issued refresh token, keyed by its id. Removed by the TTL index once it has expired. */
export interface RefreshTokenDoc {
  _id: string
  userId: string
  expiresAt: Date
  revokedAt: Date | null
}

const refreshTokenSchema = new Schema<RefreshTokenDoc>(
  {
    _id: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
  },
  { versionKey: false, collection: 'refresh_tokens' },
)
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const RefreshToken = model<RefreshTokenDoc>('RefreshToken', refreshTokenSchema)

/** Failed sign-ins per hashed email and address. Removed by the TTL index after the cool-off. */
export interface LoginAttemptDoc {
  _id: string
  failures: number
  expiresAt: Date
}

const loginAttemptSchema = new Schema<LoginAttemptDoc>(
  {
    _id: { type: String, required: true },
    failures: { type: Number, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false, collection: 'login_attempts' },
)
loginAttemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const LoginAttempt = model<LoginAttemptDoc>('LoginAttempt', loginAttemptSchema)
