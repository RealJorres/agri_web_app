/** Test data. Names are obviously synthetic ("Sample<n>"), never real people. */
import { randomUUID } from 'node:crypto'

import type { Test } from 'supertest'

import { hashPassword } from '../../src/lib/passwords.js'
import type { Role } from '../../src/lib/roles.js'
import { User, UserAssignment, type UserDoc } from '../../src/models/account.models.js'
import { Barangay, Municipality } from '../../src/models/location.models.js'
import { Commodity, Program, type CommodityDoc } from '../../src/models/catalog.models.js'
import { issueTokens } from '../../src/services/auth.service.js'

export const TEST_PASSWORD = 'synthetic-Passw0rd-for-tests'

// Hashing is deliberately slow, so one hash is shared by all test users.
const sharedHash = hashPassword(TEST_PASSWORD)
let sequence = 0

function next(): number {
  sequence += 1
  return sequence
}

export async function makeUser(
  fields: Partial<Pick<UserDoc, 'email' | 'isActive' | 'isSuperuser'>> = {},
): Promise<UserDoc> {
  const n = next()
  const user = await User.create({
    email: `sample${n}-${randomUUID()}@example.test`,
    passwordHash: await sharedHash,
    firstName: 'Test',
    lastName: `Sample${n}`,
    ...fields,
  })
  return user.toObject()
}

export async function makeMunicipality(name?: string) {
  return (await Municipality.create({ name: name ?? `Sample Municipality ${next()}` })).toObject()
}

export async function makeBarangay(municipalityId: string, name?: string) {
  const barangay = await Barangay.create({
    name: name ?? `Sample Barangay ${next()}`,
    municipalityId,
  })
  return barangay.toObject()
}

export async function makeProgram(code?: string) {
  const unique = code ?? `P${next()}`
  return (await Program.create({ code: unique, name: `Sample program ${unique}` })).toObject()
}

export async function makeCommodity(
  programId: string,
  fields: Partial<Pick<CommodityDoc, 'code' | 'name' | 'attributesSchema' | 'plantsPerHa'>> = {},
) {
  const n = next()
  const commodity = await Commodity.create({
    programId,
    code: `CROP${String(n)}`,
    name: `Sample crop ${String(n)}`,
    measureType: 'trees',
    ...fields,
  })
  return commodity.toObject()
}

export async function userWithRole(
  role: Role,
  scope: { municipalityId?: string; programId?: string; barangayIds?: string[] } = {},
  fields: Parameters<typeof makeUser>[0] = {},
): Promise<UserDoc> {
  const user = await makeUser(fields)
  await UserAssignment.create({ userId: user._id, role, ...scope })
  return user
}

/** Adds a valid access token for the user to a supertest request. */
export async function signedIn<T extends Test>(request: T, user: UserDoc): Promise<T> {
  const { access } = await issueTokens(user._id)
  return request.set('Authorization', `Bearer ${access}`)
}
