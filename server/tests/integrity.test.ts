import { beforeEach, describe, expect, it } from 'vitest'

import { Role } from '../src/lib/roles.js'
import type { Actor } from '../src/lib/scoping.js'
import {
  Commodity,
  GrowthStage,
  MaterialSource,
  Program,
  Unit,
  Variety,
} from '../src/models/catalog.models.js'
import { CropStand, Farm, Harvest, Planting } from '../src/models/farm.models.js'
import { Barangay, Municipality, type BarangayDoc } from '../src/models/location.models.js'
import { Association, AssociationMember, Farmer } from '../src/models/registry.models.js'
import { integrityProblems } from '../src/selectors/integrity.selectors.js'
import * as farms from '../src/services/farm.service.js'
import { createHarvest } from '../src/services/harvest.service.js'
import * as registry from '../src/services/registry.service.js'
import {
  actorFor,
  cacao,
  makeAssociation,
  makeBarangay,
  makeFarm,
  makeFarmer,
  makeHarvest,
  makeMember,
  makeMunicipality,
  makePlanting,
  makeStand,
  userWithRole,
} from './support/factories.js'

const UNKNOWN = '00000000-0000-4000-8000-000000000000'

let one: BarangayDoc
let two: BarangayDoc
let actor: Actor

// Each test starts from an empty database, because any leftover row would show up in the report.
beforeEach(async () => {
  await Promise.all(
    [
      Municipality,
      Barangay,
      Program,
      Commodity,
      GrowthStage,
      Variety,
      MaterialSource,
      Unit,
      Farmer,
      Association,
      AssociationMember,
      Farm,
      CropStand,
      Planting,
      Harvest,
    ].map((model) => model.collection.deleteMany({})),
  )
  one = await makeBarangay((await makeMunicipality('Integrity One'))._id, 'Synthetic One')
  two = await makeBarangay((await makeMunicipality('Integrity Two'))._id, 'Synthetic Two')
  const admin = await userWithRole(Role.SYSTEM_ADMIN)
  actor = await actorFor(admin)
})

async function problemNames(): Promise<string[]> {
  return (await integrityProblems()).map((problem) => problem.check)
}

describe('after real operations', () => {
  it('is clean after a farm moves', async () => {
    const farm = await makeFarm(one)
    const stand = await makeStand(farm)
    await farms.createPlanting({ actor, standId: stand._id, data: {} })
    await createHarvest({ actor, standId: stand._id, data: { quantity: '1', unit: 'kg' } })

    await farms.updateFarm({ actor, farmId: farm._id, data: { barangay: two._id } })

    expect(await integrityProblems()).toEqual([])
  })

  it('is clean after a farmer moves', async () => {
    const farmer = await makeFarmer(one)
    await registry.updateFarmer({
      actor,
      farmerId: farmer._id,
      data: { homeBarangay: two._id },
    })
    expect(await integrityProblems()).toEqual([])
  })

  it('is clean after farmers merge', async () => {
    const target = await makeFarmer(one)
    const duplicate = await makeFarmer(two)
    const stand = await makeStand(await makeFarm(two, { farmerId: duplicate._id }))
    await makePlanting(stand)
    const shared = await makeAssociation(one.municipalityId)
    await makeMember(target._id, shared._id)
    await makeMember(duplicate._id, shared._id)
    await makeMember(duplicate._id, (await makeAssociation(two.municipalityId))._id)

    await registry.mergeFarmers({ actor, targetId: target._id, duplicateId: duplicate._id })

    expect(await integrityProblems()).toEqual([])
  })

  it('is clean after deletes, because soft-deleted rows are not checked', async () => {
    const farmer = await makeFarmer(one)
    const association = await makeAssociation(one.municipalityId)
    await makeMember(farmer._id, association._id)
    const farm = await makeFarm(one, { farmerId: farmer._id })
    await farms.deleteFarm({ actor, farmId: farm._id })
    await registry.deleteFarmer({ actor, farmerId: farmer._id })
    expect(await integrityProblems()).toEqual([])
  })
})

describe('when something is wrong', () => {
  // Direct collection writes stand in for a bug or a manual edit in the database.
  async function corrupt(
    model: { collection: { updateOne: (...args: never[]) => Promise<unknown> } },
    id: string,
    fields: object,
  ) {
    await model.collection.updateOne({ _id: id } as never, { $set: fields } as never)
  }

  it.each<[string, (ids: Awaited<ReturnType<typeof world>>) => Promise<void>]>([
    ['farmer.home_barangay', ({ farmer }) => corrupt(Farmer, farmer, { homeBarangayId: UNKNOWN })],
    [
      'farmer.municipality_key',
      ({ farmer }) => corrupt(Farmer, farmer, { municipalityId: UNKNOWN }),
    ],
    ['farm.farmer', ({ farm }) => corrupt(Farm, farm, { farmerId: UNKNOWN })],
    ['farm.barangay', ({ farm }) => corrupt(Farm, farm, { barangayId: UNKNOWN })],
    ['farm.municipality_key', ({ farm }) => corrupt(Farm, farm, { municipalityId: UNKNOWN })],
    ['crop_stand.farm', ({ stand }) => corrupt(CropStand, stand, { farmId: UNKNOWN })],
    ['crop_stand.commodity', ({ stand }) => corrupt(CropStand, stand, { commodityId: UNKNOWN })],
    ['crop_stand.location_keys', ({ stand }) => corrupt(CropStand, stand, { barangayId: UNKNOWN })],
    ['crop_stand.program_key', ({ stand }) => corrupt(CropStand, stand, { programId: UNKNOWN })],
    [
      'planting.crop_stand',
      ({ planting }) => corrupt(Planting, planting, { cropStandId: UNKNOWN }),
    ],
    [
      'planting.scope_keys',
      ({ planting }) => corrupt(Planting, planting, { municipalityId: UNKNOWN }),
    ],
    ['planting.source', ({ planting }) => corrupt(Planting, planting, { sourceId: UNKNOWN })],
    [
      'planting.varieties',
      ({ planting }) => corrupt(Planting, planting, { varietyIds: [UNKNOWN] }),
    ],
    ['harvest.crop_stand', ({ harvest }) => corrupt(Harvest, harvest, { cropStandId: UNKNOWN })],
    ['harvest.scope_keys', ({ harvest }) => corrupt(Harvest, harvest, { programId: UNKNOWN })],
    ['member.farmer', ({ member }) => corrupt(AssociationMember, member, { farmerId: UNKNOWN })],
    [
      'member.association',
      ({ member }) => corrupt(AssociationMember, member, { associationId: UNKNOWN }),
    ],
    [
      'association.municipality',
      ({ association }) => corrupt(Association, association, { municipalityId: UNKNOWN }),
    ],
    ['barangay.municipality', async () => corrupt(Barangay, two._id, { municipalityId: UNKNOWN })],
  ])('reports %s', async (check, breakIt) => {
    const ids = await world()
    expect(await integrityProblems()).toEqual([])
    await breakIt(ids)
    expect(await problemNames()).toContain(check)
  })

  async function world() {
    await cacao()
    const farmer = await makeFarmer(one)
    const farm = await makeFarm(one, { farmerId: farmer._id })
    const stand = await makeStand(farm)
    const planting = await makePlanting(stand)
    const harvest = await makeHarvest(stand)
    const association = await makeAssociation(one.municipalityId)
    const member = await makeMember(farmer._id, association._id)
    return {
      farmer: farmer._id,
      farm: farm._id,
      stand: stand._id,
      planting: planting._id,
      harvest: harvest._id,
      association: association._id,
      member: member._id,
    }
  }

  it('reports a child of a soft-deleted parent, with ids and no personal data', async () => {
    const farmer = await makeFarmer(one, { firstName: 'Secretname', lastName: 'Sampleorphan' })
    const farm = await makeFarm(one, { farmerId: farmer._id })
    await Farmer.updateOne({ _id: farmer._id }, { isDeleted: true })

    const problems = await integrityProblems()

    expect(problems).toEqual([{ check: 'farm.farmer', count: 1, sampleIds: [farm._id] }])
    expect(JSON.stringify(problems)).not.toContain('Secretname')
  })

  it('reports a variety from another crop', async () => {
    const crop = await cacao()
    const other = await Commodity.create({
      programId: crop.programId,
      code: 'OTHERCROP',
      name: 'Sample other',
      measureType: 'trees',
    })
    const wrong = await Variety.create({ commodityId: other._id, code: 'X', name: 'X' })
    await makePlanting(await makeStand(await makeFarm(one)), { varietyIds: [wrong._id] })
    expect(await problemNames()).toEqual(['planting.varieties'])
  })
})
