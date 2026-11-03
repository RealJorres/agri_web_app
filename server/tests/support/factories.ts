/** Test data. Names are obviously synthetic ("Sample<n>"), never real people. */
import { randomUUID } from 'node:crypto'

import type { Test } from 'supertest'

import { toDecimal128 } from '../../src/lib/decimal.js'
import { hashPassword } from '../../src/lib/passwords.js'
import type { Role } from '../../src/lib/roles.js'
import type { Actor } from '../../src/lib/scoping.js'
import { User, UserAssignment, type UserDoc } from '../../src/models/account.models.js'
import { Barangay, Municipality, type BarangayDoc } from '../../src/models/location.models.js'
import {
  CropStand,
  type CropStandDoc,
  Farm,
  type FarmDoc,
  Harvest,
  type HarvestDoc,
  Planting,
  type PlantingDoc,
} from '../../src/models/farm.models.js'
import {
  Association,
  type AssociationDoc,
  AssociationMember,
  Farmer,
  type FarmerDoc,
} from '../../src/models/registry.models.js'
import { getScope } from '../../src/selectors/accounts.selectors.js'
import { Commodity, Program, type CommodityDoc } from '../../src/models/catalog.models.js'
import { issueTokens } from '../../src/services/auth.service.js'
import { seedCatalog } from '../../src/services/catalog.service.js'

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

export async function actorFor(user: UserDoc): Promise<Actor> {
  return { id: user._id, scope: await getScope(user) }
}

export async function cacao(): Promise<CommodityDoc> {
  let commodity = await Commodity.findOne({ code: 'CACAO' }).lean<CommodityDoc>()
  if (!commodity) {
    await seedCatalog()
    commodity = await Commodity.findOne({ code: 'CACAO' }).lean<CommodityDoc>()
  }
  return commodity as CommodityDoc
}

export async function makeFarmer(
  barangay: Pick<BarangayDoc, '_id' | 'municipalityId'>,
  fields: Partial<FarmerDoc> = {},
): Promise<FarmerDoc> {
  const farmer = await Farmer.create({
    firstName: 'Test',
    lastName: `Sample${String(next())}`,
    homeBarangayId: barangay._id,
    municipalityId: barangay.municipalityId,
    ...fields,
  })
  return farmer.toObject()
}

export async function makeFarm(
  barangay: Pick<BarangayDoc, '_id' | 'municipalityId'>,
  fields: Partial<FarmDoc> = {},
): Promise<FarmDoc> {
  const farmerId = fields.farmerId ?? (await makeFarmer(barangay))._id
  const farm = await Farm.create({
    barangayId: barangay._id,
    municipalityId: barangay.municipalityId,
    ...fields,
    farmerId,
  })
  return farm.toObject()
}

export async function makeStand(
  farm: FarmDoc,
  commodity?: CommodityDoc,
  fields: Partial<CropStandDoc> = {},
): Promise<CropStandDoc> {
  const crop = commodity ?? (await cacao())
  const stand = await CropStand.create({
    farmId: farm._id,
    commodityId: crop._id,
    barangayId: farm.barangayId,
    municipalityId: farm.municipalityId,
    programId: crop.programId,
    ...fields,
  })
  return stand.toObject()
}

const copiedKeys = ({ barangayId, municipalityId, programId }: CropStandDoc) => ({
  barangayId,
  municipalityId,
  programId,
})

export async function makePlanting(
  stand: CropStandDoc,
  fields: Partial<PlantingDoc> = {},
): Promise<PlantingDoc> {
  const planting = await Planting.create({
    cropStandId: stand._id,
    ...copiedKeys(stand),
    ...fields,
  })
  return planting.toObject()
}

export async function makeHarvest(
  stand: CropStandDoc,
  fields: Partial<Omit<HarvestDoc, 'quantity'>> & { quantity?: string } = {},
): Promise<HarvestDoc> {
  const { quantity = '1', ...rest } = fields
  const harvest = await Harvest.create({
    cropStandId: stand._id,
    unit: 'kg',
    ...copiedKeys(stand),
    ...rest,
    quantity: toDecimal128(quantity),
  })
  return harvest.toObject()
}

export async function makeAssociation(
  municipalityId: string,
  fields: Partial<AssociationDoc> = {},
): Promise<AssociationDoc> {
  const association = await Association.create({
    name: `Sample Farmers Association ${String(next())}`,
    municipalityId,
    ...fields,
  })
  return association.toObject()
}

export async function makeMember(farmerId: string, associationId: string) {
  return (await AssociationMember.create({ farmerId, associationId })).toObject()
}
