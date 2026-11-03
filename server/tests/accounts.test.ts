import { describe, expect, it } from 'vitest'

import { DomainError } from '../src/lib/errors.js'
import { passwordProblems } from '../src/lib/passwords.js'
import { ALL_ROLES, Cap, Role, ROLE_CAPABILITIES } from '../src/lib/roles.js'
import { canReach, requireReach, Scope, scopeFilter, type Grant } from '../src/lib/scoping.js'
import { normalizeCode, normalizeName, normalizePersonName } from '../src/lib/text.js'
import { UserAssignment } from '../src/models/account.models.js'
import { AuditLog } from '../src/models/auditLog.model.js'
import {
  assignmentProblems,
  createAssignment,
  createUser,
} from '../src/services/accounts.service.js'
import { getScope } from '../src/selectors/accounts.selectors.js'
import { makeBarangay, makeMunicipality, makeProgram, makeUser } from './support/factories.js'

const STRONG = 'synthetic-Passw0rd-for-tests'

describe('role capabilities', () => {
  it('limits viewers to aggregates', () => {
    expect([...ROLE_CAPABILITIES[Role.VIEWER]]).toEqual([Cap.VIEW_AGGREGATES])
  })

  it('defines capabilities for every role', () => {
    expect(Object.keys(ROLE_CAPABILITIES).sort()).toEqual([...ALL_ROLES].sort())
  })

  it('lets only validators validate and only coordinators approve', () => {
    const holders = (capability: Cap) =>
      ALL_ROLES.filter((role) => ROLE_CAPABILITIES[role].has(capability)).sort()
    expect(holders(Cap.VALIDATE)).toEqual([Role.MAO_VALIDATOR, Role.SYSTEM_ADMIN])
    expect(holders(Cap.APPROVE)).toEqual([Role.PROGRAM_COORDINATOR, Role.SYSTEM_ADMIN])
  })
})

describe('assignmentProblems', () => {
  const gasan = { _id: 'gasan', name: 'Gasan' }
  const inBoac = { municipalityId: 'boac' }
  const inGasan = { municipalityId: 'gasan' }

  it.each([
    [Role.MAO_VALIDATOR, null, [], 'municipality'],
    [Role.FIELD_ENCODER, null, [], 'municipality'],
    [Role.MAO_VALIDATOR, gasan, [inGasan], 'barangays'],
    [Role.FIELD_ENCODER, null, [inGasan], 'municipality'],
  ])('flags %s with municipality %j and barangays %j', (role, municipality, barangays, field) => {
    expect(Object.keys(assignmentProblems({ role, municipality, barangays }))).toEqual([field])
  })

  it('names the municipality when a barangay is outside it', () => {
    expect(
      assignmentProblems({ role: Role.FIELD_ENCODER, municipality: gasan, barangays: [inBoac] }),
    ).toEqual({ barangays: ['All barangays must be in Gasan.'] })
  })

  it('accepts a valid field encoder and an unrestricted viewer', () => {
    expect(
      assignmentProblems({ role: Role.FIELD_ENCODER, municipality: gasan, barangays: [inGasan] }),
    ).toEqual({})
    expect(assignmentProblems({ role: Role.VIEWER, municipality: null, barangays: [] })).toEqual({})
  })
})

describe('createAssignment', () => {
  it('raises a field error for an invalid assignment, and writes nothing', async () => {
    const user = await makeUser()
    const attempt = createAssignment({ userId: user._id, role: Role.MAO_VALIDATOR, actorId: null })
    await expect(attempt).rejects.toMatchObject({
      code: 'invalid_assignment',
      fields: { municipality: expect.any(Array) as unknown },
    })
    expect(await UserAssignment.countDocuments({ userId: user._id })).toBe(0)
  })

  it('refuses a reference that does not exist', async () => {
    const user = await makeUser()
    const attempt = createAssignment({
      userId: user._id,
      role: Role.MAO_VALIDATOR,
      municipalityId: 'missing',
      actorId: null,
    })
    await expect(attempt).rejects.toMatchObject({ fields: { municipality: ['Not found.'] } })
  })

  it('saves the assignment and its audit entry together', async () => {
    const actor = await makeUser()
    const user = await makeUser()
    const municipality = await makeMunicipality()
    const barangay = await makeBarangay(municipality._id)
    const created = await createAssignment({
      userId: user._id,
      role: Role.FIELD_ENCODER,
      municipalityId: municipality._id,
      barangayIds: [barangay._id],
      actorId: actor._id,
    })
    const entry = await AuditLog.findOne({ objectId: created._id }).lean()
    expect(entry).toMatchObject({ action: 'assignment.create', actorId: actor._id })
  })

  it('refuses a second identical assignment, but allows one after a soft delete', async () => {
    await UserAssignment.init()
    const user = await makeUser()
    const input = { userId: user._id, role: Role.VIEWER, actorId: null }
    const first = await createAssignment(input)
    await expect(createAssignment(input)).rejects.toMatchObject({ code: 'invalid_assignment' })
    await UserAssignment.updateOne(
      { _id: first._id },
      { $set: { isDeleted: true, deletedAt: new Date() } },
    )
    await expect(createAssignment(input)).resolves.toMatchObject({ role: Role.VIEWER })
    expect(await UserAssignment.countDocuments({ userId: user._id })).toBe(1)
  })
})

describe('createUser', () => {
  it('stores a hash, and masks personal values in the audit entry', async () => {
    const created = await createUser({
      email: ' Sample.Admin@Example.test ',
      password: STRONG,
      firstName: 'Fictional',
      lastName: 'Person',
      isSuperuser: true,
      actorId: null,
    })
    expect(created.email).toBe('sample.admin@example.test')
    expect(created.passwordHash).toMatch(/^\$argon2id\$/)
    const entry = await AuditLog.findOne({ objectId: created._id }).lean()
    const logged = JSON.stringify(entry)
    expect(logged).not.toContain('sample.admin')
    expect(logged).not.toContain('Fictional')
    expect(logged).not.toContain('argon2')
    expect(entry?.after).toMatchObject({ email: '[personal]', isSuperuser: true })
  })

  it('refuses a weak password or an email already in use', async () => {
    await expect(
      createUser({ email: 'weak@example.test', password: 'short', actorId: null }),
    ).rejects.toMatchObject({ code: 'invalid_password' })
    const user = await makeUser()
    await expect(
      createUser({ email: user.email, password: STRONG, actorId: null }),
    ).rejects.toMatchObject({ code: 'duplicate_user' })
  })
})

describe('passwordProblems', () => {
  it.each([
    ['short', [], /at least 12/],
    ['123456789012345', [], /only numbers/],
    ['Password12345', [], /too common/],
    ['maria-santos-2026', ['Maria'], /your name/],
  ])('rejects %s', (password, personal, expected) => {
    expect(passwordProblems(password, personal).join(' ')).toMatch(expected)
  })

  it('accepts a good password', () => {
    expect(passwordProblems(STRONG, ['Sample'])).toEqual([])
  })
})

describe('getScope', () => {
  it('ignores soft-deleted assignments and gives inactive users no grants', async () => {
    const user = await makeUser()
    const program = await makeProgram()
    const created = await createAssignment({
      userId: user._id,
      role: Role.PROGRAM_COORDINATOR,
      programId: program._id,
      actorId: null,
    })
    expect((await getScope(user)).roles).toEqual([Role.PROGRAM_COORDINATOR])
    expect((await getScope({ ...user, isActive: false })).grants).toEqual([])
    await UserAssignment.updateOne({ _id: created._id }, { $set: { isDeleted: true } })
    expect((await getScope(user)).grants).toEqual([])
  })
})

function grant(fields: Partial<Grant> & { role: Role }): Grant {
  return { municipalityId: null, programId: null, barangayIds: new Set(), ...fields }
}

describe('scopeFilter', () => {
  const paths = { barangay: 'barangayId', municipality: 'municipalityId', program: 'programId' }

  it('matches nothing when no grant carries the capability', () => {
    const scope = new Scope('u', [grant({ role: Role.VIEWER })])
    expect(scopeFilter(scope, Cap.VIEW_RECORDS, paths)).toEqual({ _id: { $in: [] } })
  })

  it('is unrestricted when any grant is', () => {
    const scope = new Scope('u', [
      grant({ role: Role.MAO_VALIDATOR, municipalityId: 'm1' }),
      grant({ role: Role.PROVINCIAL_HEAD }),
    ])
    expect(scopeFilter(scope, Cap.VIEW_RECORDS, paths)).toEqual({})
  })

  it('prefers barangays over the municipality', () => {
    const scope = new Scope('u', [
      grant({ role: Role.FIELD_ENCODER, municipalityId: 'm1', barangayIds: new Set(['b1']) }),
    ])
    expect(scopeFilter(scope, Cap.VIEW_RECORDS, paths)).toEqual({
      $or: [{ barangayId: { $in: ['b1'] } }],
    })
  })

  it('falls back to the municipality when the collection has no barangay field', () => {
    const scope = new Scope('u', [
      grant({ role: Role.FIELD_ENCODER, municipalityId: 'm1', barangayIds: new Set(['b1']) }),
    ])
    expect(scopeFilter(scope, Cap.VIEW_RECORDS, { municipality: 'municipalityId' })).toEqual({
      $or: [{ municipalityId: 'm1' }],
    })
  })

  it('denies location-limited grants on data with no location', () => {
    const scope = new Scope('u', [grant({ role: Role.MAO_VALIDATOR, municipalityId: 'm1' })])
    expect(scopeFilter(scope, Cap.VIEW_RECORDS, { program: 'programId' })).toEqual({
      _id: { $in: [] },
    })
  })

  it('applies the program only where the collection has one', () => {
    const scope = new Scope('u', [grant({ role: Role.PROGRAM_COORDINATOR, programId: 'p1' })])
    expect(scopeFilter(scope, Cap.VIEW_RECORDS, paths)).toEqual({ $or: [{ programId: 'p1' }] })
    expect(scopeFilter(scope, Cap.VIEW_RECORDS, { barangay: 'barangayId' })).toEqual({})
  })

  it('combines grants with OR', () => {
    const scope = new Scope('u', [
      grant({ role: Role.MAO_VALIDATOR, municipalityId: 'm1' }),
      grant({ role: Role.MAO_VALIDATOR, municipalityId: 'm2' }),
    ])
    expect(scopeFilter(scope, Cap.VIEW_RECORDS, paths)).toEqual({
      $or: [{ municipalityId: 'm1' }, { municipalityId: 'm2' }],
    })
  })
})

describe('canReach and requireReach', () => {
  const encoder = new Scope('u', [
    grant({ role: Role.FIELD_ENCODER, municipalityId: 'm1', barangayIds: new Set(['b1']) }),
  ])

  it('checks barangay, municipality and program', () => {
    const edit = Cap.EDIT_RECORDS
    expect(canReach(encoder, edit, { barangayId: 'b1', municipalityId: 'm1' })).toBe(true)
    expect(canReach(encoder, edit, { barangayId: 'b2', municipalityId: 'm1' })).toBe(false)
    expect(canReach(encoder, edit, { municipalityId: 'm1' })).toBe(true)
    expect(canReach(encoder, edit, { municipalityId: 'm2' })).toBe(false)
    expect(canReach(encoder, Cap.APPROVE, { barangayId: 'b1' })).toBe(false)

    const coordinator = new Scope('u', [grant({ role: Role.PROGRAM_COORDINATOR, programId: 'p1' })])
    expect(canReach(coordinator, Cap.APPROVE, { programId: 'p1' })).toBe(true)
    expect(canReach(coordinator, Cap.APPROVE, { programId: 'p2' })).toBe(false)
  })

  it('raises a 403 that names the field', () => {
    const attempt = () => {
      requireReach(encoder, Cap.EDIT_RECORDS, { municipalityId: 'm2' }, 'home_barangay')
    }
    expect(attempt).toThrow(DomainError)
    expect(attempt).toThrow('outside your assignment')
  })
})

describe('text normalization', () => {
  it('matches the rules the imports rely on', () => {
    expect(normalizeName('Sta. Niño ')).toBe('sta nino')
    expect(normalizeName('A_B')).toBe('a b')
    expect(normalizeCode('br 25')).toBe('BR25')
    expect(normalizeCode('DA- RFO')).toBe('DARFO')
    expect(normalizePersonName('Ma. Luisa Reyes Jr.')).toBe('maria luisa reyes')
    expect(normalizePersonName('Engr. Juan V. Cruz')).toBe('juan v cruz')
    expect(normalizeName(null)).toBe('')
  })
})
