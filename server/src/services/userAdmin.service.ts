/**
 * Administrators' changes to staff accounts. Accounts are deactivated, never deleted, because audit
 * entries point at them. The system can never be left without an active administrator.
 */
import type { ClientSession } from 'mongoose'

import { DomainError, notFound } from '../lib/errors.js'
import { isDuplicateKey } from '../lib/mongoErrors.js'
import { hashPassword, passwordProblems } from '../lib/passwords.js'
import { Role } from '../lib/roles.js'
import { inTransaction } from '../lib/transaction.js'
import { User, UserAssignment, type UserDoc } from '../models/account.models.js'
import { markDeleted } from '../models/base.js'
import { changes, recordAudit } from './audit.service.js'
import { revokeAllTokens } from './auth.service.js'

const USER_PERSONAL_FIELDS = ['email', 'firstName', 'lastName']

/** Refuses a change that would leave no one else able to administer the system. */
async function requireAnotherAdmin(userId: string, session: ClientSession): Promise<void> {
  const superuser = await User.exists({
    _id: { $ne: userId },
    isActive: true,
    isSuperuser: true,
  }).session(session)
  if (superuser) return
  const holders = await UserAssignment.find({ role: Role.SYSTEM_ADMIN, userId: { $ne: userId } })
    .session(session)
    .lean()
  const active = await User.exists({
    _id: { $in: holders.map((holder) => holder.userId) },
    isActive: true,
  }).session(session)
  if (!active) {
    throw new DomainError(
      'last_admin',
      'This would leave no active system administrator. Give someone else that role first.',
      {},
      409,
    )
  }
}

export async function updateUser(input: {
  actorId: string
  id: string
  email?: string | undefined
  firstName?: string | undefined
  lastName?: string | undefined
  isActive?: boolean | undefined
}): Promise<UserDoc> {
  try {
    const updated = await inTransaction(async (session) => {
      const user = await User.findById(input.id).session(session)
      if (!user) throw notFound()
      const before = {
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        isActive: user.isActive,
      }
      if (input.isActive === false && user._id === input.actorId) {
        throw new DomainError('own_account', 'You cannot deactivate your own account.', {}, 409)
      }
      if (input.email !== undefined) user.email = input.email.trim().toLowerCase()
      if (input.firstName !== undefined) user.firstName = input.firstName
      if (input.lastName !== undefined) user.lastName = input.lastName
      if (input.isActive !== undefined) user.isActive = input.isActive
      await user.save({ session })
      const after = {
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        isActive: user.isActive,
      }
      await recordAudit({
        actorId: input.actorId,
        action: 'user.update',
        objectType: 'user',
        objectId: user._id,
        ...changes(before, after, USER_PERSONAL_FIELDS),
        session,
      })
      return user.toObject()
    })
    if (input.isActive === false) await revokeAllTokens(input.id)
    return updated
  } catch (error) {
    if (!isDuplicateKey(error, 'email')) throw error
    const message = 'This email already has an account.'
    throw new DomainError('duplicate_user', message, { email: [message] })
  }
}

/** Sets a new password and signs the person out everywhere. The password is never audited. */
export async function resetPassword(input: {
  actorId: string
  id: string
  password: string
}): Promise<void> {
  const existing = await User.findById(input.id).lean<UserDoc>()
  if (!existing) throw notFound()
  const problems = passwordProblems(input.password, [
    existing.email.split('@')[0] ?? '',
    existing.firstName,
    existing.lastName,
  ])
  if (problems.length > 0) {
    throw new DomainError('invalid_password', 'The password is not acceptable.', {
      password: problems,
    })
  }
  const passwordHash = await hashPassword(input.password)
  await inTransaction(async (session) => {
    await User.updateOne({ _id: input.id }, { passwordHash }, { session })
    await recordAudit({
      actorId: input.actorId,
      action: 'user.reset_password',
      objectType: 'user',
      objectId: input.id,
      session,
    })
  })
  await revokeAllTokens(input.id)
}

export async function removeAssignment(input: {
  actorId: string
  userId: string
  assignmentId: string
}): Promise<void> {
  await inTransaction(async (session) => {
    const assignment = await UserAssignment.findOne({
      _id: input.assignmentId,
      userId: input.userId,
    }).session(session)
    if (!assignment) throw notFound()
    if (assignment.role === Role.SYSTEM_ADMIN) {
      const user = await User.findById(input.userId).session(session).lean<UserDoc>()
      const others = await UserAssignment.exists({
        _id: { $ne: assignment._id },
        userId: input.userId,
        role: Role.SYSTEM_ADMIN,
      }).session(session)
      if (!user?.isSuperuser && !others) await requireAnotherAdmin(input.userId, session)
    }
    markDeleted(assignment, input.actorId)
    await assignment.save({ session })
    await recordAudit({
      actorId: input.actorId,
      action: 'assignment.delete',
      objectType: 'user_assignment',
      objectId: assignment._id,
      before: {
        userId: assignment.userId,
        role: assignment.role,
        municipalityId: assignment.municipalityId,
        programId: assignment.programId,
        barangayIds: assignment.barangayIds,
      },
      session,
    })
  })
}
