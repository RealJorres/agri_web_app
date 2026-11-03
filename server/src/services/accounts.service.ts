import type { ClientSession } from 'mongoose'

import { DomainError, type ErrorFields } from '../lib/errors.js'
import { hashPassword, passwordProblems } from '../lib/passwords.js'
import { BARANGAY_SCOPED_ROLES, Role } from '../lib/roles.js'
import { inTransaction } from '../lib/transaction.js'
import {
  User,
  UserAssignment,
  type UserAssignmentDoc,
  type UserDoc,
} from '../models/account.models.js'
import { Barangay, Municipality, type BarangayDoc } from '../models/location.models.js'
import { Program } from '../models/catalog.models.js'
import { mask, recordAudit } from './audit.service.js'

const USER_PERSONAL_FIELDS = ['email', 'firstName', 'lastName']
const DUPLICATE_KEY = 11000

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown }).code === DUPLICATE_KEY
}

export async function createUser(input: {
  email: string
  password: string
  firstName?: string
  lastName?: string
  isSuperuser?: boolean
  actorId: string | null
}): Promise<UserDoc> {
  const email = input.email.trim().toLowerCase()
  const firstName = input.firstName ?? ''
  const lastName = input.lastName ?? ''
  const problems = passwordProblems(input.password, [
    email.split('@')[0] ?? '',
    firstName,
    lastName,
  ])
  if (problems.length > 0) {
    throw new DomainError('invalid_password', 'The password is not acceptable.', {
      password: problems,
    })
  }
  const passwordHash = await hashPassword(input.password)
  const isSuperuser = input.isSuperuser ?? false
  try {
    return await inTransaction(async (session) => {
      const [created] = await User.create(
        [{ email, passwordHash, firstName, lastName, isSuperuser }],
        { session },
      )
      if (!created) throw new Error('User was not created')
      await recordAudit({
        actorId: input.actorId,
        action: 'user.create',
        objectType: 'user',
        objectId: created._id,
        after: mask({ email, firstName, lastName, isSuperuser }, USER_PERSONAL_FIELDS),
        session,
      })
      return created.toObject()
    })
  } catch (error) {
    if (!isDuplicateKey(error)) throw error
    throw new DomainError('duplicate_user', 'This email already has an account.', {
      email: ['This email already has an account.'],
    })
  }
}

/** Field errors for an assignment (empty when valid). */
export function assignmentProblems(input: {
  role: Role
  municipality: { _id: string; name: string } | null
  program?: { _id: string } | null
  barangays: readonly Pick<BarangayDoc, 'municipalityId'>[]
}): ErrorFields {
  const { role, municipality, barangays } = input
  const scopedToBarangays = BARANGAY_SCOPED_ROLES.has(role)
  if (role === Role.SYSTEM_ADMIN && (municipality || input.program)) {
    return { role: ['A system admin covers the whole province and every program.'] }
  }
  if (role === Role.MAO_VALIDATOR && !municipality) {
    return { municipality: ['An MAO validator must be assigned to one municipality.'] }
  }
  if (barangays.length === 0) {
    return scopedToBarangays && !municipality
      ? { municipality: ['A field encoder must be assigned to a municipality.'] }
      : {}
  }
  if (!scopedToBarangays) return { barangays: ['Only field encoders can be limited to barangays.'] }
  if (!municipality) return { municipality: ['Choose the municipality the barangays belong to.'] }
  return barangays.every((barangay) => barangay.municipalityId === municipality._id)
    ? {}
    : { barangays: [`All barangays must be in ${municipality.name}.`] }
}

async function loadReference<T>(
  id: string | null | undefined,
  field: string,
  find: (id: string, session: ClientSession) => Promise<T | null>,
  session: ClientSession,
): Promise<T | null> {
  if (!id) return null
  const found = await find(id, session)
  if (!found) {
    throw new DomainError('invalid_assignment', 'The assignment is not valid.', {
      [field]: ['Not found.'],
    })
  }
  return found
}

export async function createAssignment(input: {
  userId: string
  role: Role
  municipalityId?: string | null
  programId?: string | null
  barangayIds?: readonly string[]
  actorId: string | null
}): Promise<UserAssignmentDoc> {
  const barangayIds = [...new Set(input.barangayIds ?? [])]
  try {
    return await inTransaction(async (session) => {
      const user = await User.exists({ _id: input.userId }).session(session)
      if (!user) {
        throw new DomainError('invalid_assignment', 'The assignment is not valid.', {
          user: ['Not found.'],
        })
      }
      const municipality = await loadReference(
        input.municipalityId,
        'municipality',
        (id, s) => Municipality.findById(id).session(s).lean(),
        session,
      )
      const program = await loadReference(
        input.programId,
        'program',
        (id, s) => Program.findById(id).session(s).lean(),
        session,
      )
      const barangays = await Barangay.find({ _id: { $in: barangayIds } })
        .session(session)
        .lean()
      if (barangays.length !== barangayIds.length) {
        throw new DomainError('invalid_assignment', 'The assignment is not valid.', {
          barangays: ['Not found.'],
        })
      }
      const problems = assignmentProblems({ role: input.role, municipality, program, barangays })
      if (Object.keys(problems).length > 0) {
        throw new DomainError('invalid_assignment', 'The assignment is not valid.', problems)
      }
      const fields = {
        userId: input.userId,
        role: input.role,
        municipalityId: municipality?._id ?? null,
        programId: program?._id ?? null,
        barangayIds,
      }
      const [created] = await UserAssignment.create(
        [{ ...fields, createdBy: input.actorId, updatedBy: input.actorId }],
        { session },
      )
      if (!created) throw new Error('Assignment was not created')
      await recordAudit({
        actorId: input.actorId,
        action: 'assignment.create',
        objectType: 'user_assignment',
        objectId: created._id,
        after: fields,
        session,
      })
      return created.toObject()
    })
  } catch (error) {
    if (!isDuplicateKey(error)) throw error
    throw new DomainError('invalid_assignment', 'This user already has this assignment.')
  }
}
