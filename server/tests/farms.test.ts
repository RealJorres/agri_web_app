import request from 'supertest'
import { beforeAll, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { Role } from '../src/lib/roles.js'
import type { Actor } from '../src/lib/scoping.js'
import { markDeleted } from '../src/models/base.js'
import { AuditLog } from '../src/models/auditLog.model.js'
import {
  Commodity,
  MaterialSource,
  Variety,
  type CommodityDoc,
} from '../src/models/catalog.models.js'
import { CropStand, Farm, Harvest, Planting } from '../src/models/farm.models.js'
import type { BarangayDoc, MunicipalityDoc } from '../src/models/location.models.js'
import { createAssignment } from '../src/services/accounts.service.js'
import * as services from '../src/services/farm.service.js'
import { contractProblems, schemaProblems } from './support/contract.js'
import {
  actorFor,
  cacao,
  makeBarangay,
  makeFarm,
  makeFarmer,
  makeHarvest,
  makeMunicipality,
  makePlanting,
  makeProgram,
  makeStand,
  signedIn,
  userWithRole,
} from './support/factories.js'

const app = createApp({ production: false })

let gasan: MunicipalityDoc
let boac: MunicipalityDoc
let brgy: BarangayDoc
let boacBrgy: BarangayDoc
let encoder: Actor
let crop: CommodityDoc

function latestAudit(action: string, objectId: string) {
  return AuditLog.findOne({ action, objectId }).sort({ createdAt: -1 }).lean()
}

beforeAll(async () => {
  await Promise.all([CropStand.init(), Farm.init()])
  gasan = await makeMunicipality('Gasan Farms')
  boac = await makeMunicipality('Boac Farms')
  brgy = await makeBarangay(gasan._id, 'Synthetic Gasan Farm')
  boacBrgy = await makeBarangay(boac._id, 'Synthetic Boac Farm')
  encoder = await actorFor(await userWithRole(Role.MAO_VALIDATOR, { municipalityId: gasan._id }))
  crop = await cacao()
})

describe('farms', () => {
  it('audit with a masked location', async () => {
    const farmer = await makeFarmer(brgy)
    const farm = await services.createFarm({
      actor: encoder,
      farmerId: farmer._id,
      data: { barangay: brgy._id, sitio: '  Synthetic  Sitio ', locationRaw: 'x' },
    })
    expect(farm.sitio).toBe('Synthetic Sitio')
    expect(farm.municipalityId).toBe(gasan._id)
    const entry = await latestAudit('farm.create', farm._id)
    const after = entry?.after as Record<string, unknown>
    expect(after.sitio).toBe('[personal]')
    expect(after.farmer).toBe(farmer._id)
  })

  it('must be in scope, and need a barangay', async () => {
    const farmer = await makeFarmer(brgy)
    await expect(
      services.createFarm({
        actor: encoder,
        farmerId: farmer._id,
        data: { barangay: boacBrgy._id },
      }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      services.createFarm({ actor: encoder, farmerId: farmer._id, data: {} }),
    ).rejects.toMatchObject({ code: 'barangay_required' })
  })

  it('update and delete, blocked while crop stands remain', async () => {
    const farm = await makeFarm(brgy)
    await services.updateFarm({ actor: encoder, farmId: farm._id, data: { tenure: 'owner' } })
    expect((await latestAudit('farm.update', farm._id))?.after).toEqual({ tenure: 'owner' })

    const stand = await makeStand(farm)
    await expect(services.deleteFarm({ actor: encoder, farmId: farm._id })).rejects.toMatchObject({
      code: 'has_crop_stands',
    })
    await services.deleteCropStand({ actor: encoder, standId: stand._id })
    await services.deleteFarm({ actor: encoder, farmId: farm._id })
    expect(await Farm.exists({ _id: farm._id })).toBeNull()
  })

  it('cannot change owner except by merge', async () => {
    const farm = await makeFarm(brgy)
    const other = await makeFarmer(brgy)
    await expect(
      services.updateFarm({ actor: encoder, farmId: farm._id, data: {}, farmerId: other._id }),
    ).rejects.toMatchObject({ code: 'farmer_immutable' })
  })
})

describe('moving a farm', () => {
  it('carries its location keys to everything under it, deleted rows included', async () => {
    const provincial = await actorFor(await userWithRole(Role.PROVINCIAL_ENCODER))
    const farm = await makeFarm(brgy)
    const stand = await makeStand(farm)
    const planting = await makePlanting(stand)
    const harvest = await makeHarvest(stand)
    const gone = await makeHarvest(stand)
    await Harvest.updateOne({ _id: gone._id }, { isDeleted: true })
    const untouchedFarm = await makeFarm(brgy)
    const untouched = await makeStand(untouchedFarm)

    await services.updateFarm({
      actor: provincial,
      farmId: farm._id,
      data: { barangay: boacBrgy._id },
    })

    const expected = { barangayId: boacBrgy._id, municipalityId: boac._id }
    expect(await Farm.findOne({ _id: farm._id }).lean()).toMatchObject(expected)
    expect(await CropStand.findOne({ _id: stand._id }).lean()).toMatchObject(expected)
    expect(await Planting.findOne({ _id: planting._id }).lean()).toMatchObject(expected)
    expect(await Harvest.findOne({ _id: harvest._id }).lean()).toMatchObject(expected)
    expect(await Harvest.findOne({ _id: gone._id, isDeleted: true }).lean()).toMatchObject(expected)
    expect(await CropStand.findOne({ _id: untouched._id }).lean()).toMatchObject({
      barangayId: brgy._id,
    })
    expect((await latestAudit('farm.update', farm._id))?.after).toEqual({
      barangay: boacBrgy._id,
    })
  })

  it('takes the rows out of the old scope and into the new one', async () => {
    const provincial = await actorFor(await userWithRole(Role.PROVINCIAL_ENCODER))
    const boacValidator = await userWithRole(Role.MAO_VALIDATOR, { municipalityId: boac._id })
    const gasanValidator = await userWithRole(Role.MAO_VALIDATOR, { municipalityId: gasan._id })
    const farm = await makeFarm(brgy)
    const stand = await makeStand(farm)
    await services.updateFarm({
      actor: provincial,
      farmId: farm._id,
      data: { barangay: boacBrgy._id },
    })
    const url = `/api/v1/crop-stands/${stand._id}`
    expect((await signedIn(request(app).get(url), boacValidator)).status).toBe(200)
    expect((await signedIn(request(app).get(url), gasanValidator)).status).toBe(404)
  })

  it('refuses a move out of scope, changing nothing', async () => {
    const farm = await makeFarm(brgy)
    const stand = await makeStand(farm)
    await expect(
      services.updateFarm({ actor: encoder, farmId: farm._id, data: { barangay: boacBrgy._id } }),
    ).rejects.toMatchObject({ status: 403 })
    expect((await CropStand.findOne({ _id: stand._id }).lean())?.barangayId).toBe(brgy._id)
  })
})

describe('crop stands', () => {
  it('copy the farm and program keys', async () => {
    const farm = await makeFarm(brgy)
    const stand = await services.createCropStand({
      actor: encoder,
      farmId: farm._id,
      commodityId: crop._id,
      data: {},
    })
    expect(stand).toMatchObject({
      barangayId: brgy._id,
      municipalityId: gasan._id,
      programId: crop.programId,
    })
  })

  it('are unique per commodity on a farm', async () => {
    const farm = await makeFarm(brgy)
    const input = { actor: encoder, farmId: farm._id, commodityId: crop._id, data: {} }
    await services.createCropStand(input)
    await expect(services.createCropStand(input)).rejects.toMatchObject({
      code: 'duplicate_crop_stand',
      status: 409,
    })
  })

  it('validate attributes against the commodity schema', async () => {
    const farm = await makeFarm(brgy)
    const base = { actor: encoder, farmId: farm._id, commodityId: crop._id }
    await expect(
      services.createCropStand({ ...base, data: { attributes: { colour: 'x' } } }),
    ).rejects.toMatchObject({ code: 'invalid_attributes' })

    const stand = await services.createCropStand({
      ...base,
      data: { attributes: { shade_trees: true } },
    })
    await services.updateCropStand({
      actor: encoder,
      standId: stand._id,
      data: { spacingM: '3' },
    })
    await expect(
      services.updateCropStand({
        actor: encoder,
        standId: stand._id,
        data: { attributes: { x: 1 } },
      }),
    ).rejects.toMatchObject({ code: 'invalid_attributes' })
  })

  it('respect a program-restricted grant', async () => {
    const other = await makeProgram('OTHER')
    const user = await userWithRole(Role.PROVINCIAL_ENCODER, { programId: other._id })
    const farm = await makeFarm(brgy)
    const input = { farmId: farm._id, commodityId: crop._id, data: {} }
    await expect(
      services.createCropStand({ actor: await actorFor(user), ...input }),
    ).rejects.toMatchObject({ status: 403 })

    await createAssignment({
      userId: user._id,
      role: Role.PROVINCIAL_ENCODER,
      programId: crop.programId,
      actorId: null,
    })
    await services.createCropStand({ actor: await actorFor(user), ...input })
  })

  it('refuse an unknown commodity', async () => {
    const farm = await makeFarm(brgy)
    await expect(
      services.createCropStand({
        actor: encoder,
        farmId: farm._id,
        commodityId: '00000000-0000-4000-8000-000000000000',
        data: {},
      }),
    ).rejects.toMatchObject({ code: 'validation_error' })
  })
})

describe('plantings', () => {
  it('check varieties against the commodity, and audit by code', async () => {
    const stand = await makeStand(await makeFarm(brgy))
    const br25 = await Variety.findOne({ commodityId: crop._id, code: 'BR25' }).lean()
    const other = await Commodity.create({
      programId: crop.programId,
      code: `COFFEE${stand._id.slice(0, 4)}`,
      name: 'Sample coffee',
      measureType: 'trees',
    })
    const robusta = await Variety.create({ commodityId: other._id, code: 'ROB', name: 'Robusta' })

    const planting = await services.createPlanting({
      actor: encoder,
      standId: stand._id,
      data: { yearPlanted: 2018 },
      varietyIds: [br25?._id as string],
    })
    expect(planting.programId).toBe(crop.programId)
    expect((await latestAudit('planting.create', planting._id))?.after).toMatchObject({
      varieties: ['BR25'],
    })

    await expect(
      services.createPlanting({
        actor: encoder,
        standId: stand._id,
        data: {},
        varietyIds: [robusta._id],
      }),
    ).rejects.toMatchObject({ code: 'variety_mismatch' })

    await services.updatePlanting({
      actor: encoder,
      plantingId: planting._id,
      data: { qtyPlanted: 50 },
      varietyIds: [],
    })
    expect((await latestAudit('planting.update', planting._id))?.after).toEqual({
      qty_planted: 50,
      varieties: [],
    })

    await expect(
      services.deleteCropStand({ actor: encoder, standId: stand._id }),
    ).rejects.toMatchObject({ code: 'has_plantings' })
    await services.deletePlanting({ actor: encoder, plantingId: planting._id })
    expect(await latestAudit('planting.delete', planting._id)).not.toBeNull()
  })

  it('are out of reach from another municipality', async () => {
    const planting = await makePlanting(await makeStand(await makeFarm(brgy)))
    const actor = await actorFor(
      await userWithRole(Role.MAO_VALIDATOR, { municipalityId: boac._id }),
    )
    await expect(
      services.updatePlanting({ actor, plantingId: planting._id, data: { notes: 'x' } }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('refuse an unknown source or variety', async () => {
    const stand = await makeStand(await makeFarm(brgy))
    const unknown = '00000000-0000-4000-8000-000000000000'
    await expect(
      services.createPlanting({ actor: encoder, standId: stand._id, data: { source: unknown } }),
    ).rejects.toMatchObject({ code: 'validation_error' })
    await expect(
      services.createPlanting({
        actor: encoder,
        standId: stand._id,
        data: {},
        varietyIds: [unknown],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' })
  })
})

describe('the farms API', () => {
  async function head() {
    return userWithRole(Role.PROVINCIAL_HEAD)
  }

  it('walks a farm from creation to deletion, to the contract', async () => {
    const user = await userWithRole(Role.MAO_VALIDATOR, { municipalityId: gasan._id })
    const farmer = await makeFarmer(brgy)
    const created = await signedIn(
      request(app)
        .post('/api/v1/farms')
        .send({
          farmer: farmer._id,
          barangay: brgy._id,
          sitio: 'Synthetic',
          declared_area_ha: '1.5',
          tenure: 'owner',
          location: { lon: 121.9, lat: 13.4 },
        }),
      user,
    )
    expect(created.status).toBe(201)
    expect(contractProblems('/api/v1/farms', 'post', 201, created.body)).toEqual([])
    expect(created.body).toMatchObject({
      declared_area_ha: '1.5000',
      location: { lon: 121.9, lat: 13.4 },
      crop_stands: [],
    })
    const { id } = created.body as { id: string }

    const stand = await signedIn(
      request(app)
        .post(`/api/v1/farms/${id}/crop-stands`)
        .send({ commodity: crop._id, spacing_m: '4', attributes: { shade_trees: true } }),
      user,
    )
    expect(stand.status).toBe(201)
    expect(schemaProblems('CropStand', stand.body)).toEqual([])
    expect(stand.body).toMatchObject({ spacing_m: '4.00', attributes: { shade_trees: true } })
    const { id: standId } = stand.body as { id: string }

    const source = await MaterialSource.findOne({ code: 'PCA' }).lean()
    const variety = await Variety.findOne({ commodityId: crop._id, code: 'K1' }).lean()
    const planting = await signedIn(
      request(app)
        .post(`/api/v1/crop-stands/${standId}/plantings`)
        .send({
          year_planted: 2018,
          source: source?._id,
          qty_planted: 5,
          varieties: [variety?._id],
        }),
      user,
    )
    expect(planting.status).toBe(201)
    expect(schemaProblems('Planting', planting.body)).toEqual([])
    expect(planting.body).toMatchObject({ source: 'PCA', varieties: ['K1'] })
    const { id: plantingId } = planting.body as { id: string }

    const farm = await signedIn(request(app).get(`/api/v1/farms/${id}`), user)
    expect(contractProblems('/api/v1/farms/{id}', 'get', 200, farm.body)).toEqual([])
    const nested = farm.body as { crop_stands: { plantings: unknown[] }[] }
    expect(nested.crop_stands[0]?.plantings).toHaveLength(1)

    const listed = await signedIn(request(app).get(`/api/v1/farms?farmer=${farmer._id}`), user)
    expect(contractProblems('/api/v1/farms', 'get', 200, listed.body)).toEqual([])
    expect((listed.body as { count: number }).count).toBe(1)

    const stands = await signedIn(request(app).get(`/api/v1/farms/${id}/crop-stands`), user)
    expect(contractProblems('/api/v1/farms/{id}/crop-stands', 'get', 200, stands.body)).toEqual([])
    const allStands = await signedIn(request(app).get('/api/v1/crop-stands?page_size=1'), user)
    expect(contractProblems('/api/v1/crop-stands', 'get', 200, allStands.body)).toEqual([])
    const plantings = await signedIn(
      request(app).get(`/api/v1/crop-stands/${standId}/plantings`),
      user,
    )
    const plantingsPath = '/api/v1/crop-stands/{id}/plantings'
    expect(contractProblems(plantingsPath, 'get', 200, plantings.body)).toEqual([])

    const patched = await signedIn(
      request(app).patch(`/api/v1/plantings/${plantingId}`).send({ notes: 'Synthetic note' }),
      user,
    )
    expect(contractProblems('/api/v1/plantings/{id}', 'patch', 200, patched.body)).toEqual([])
    const standPatched = await signedIn(
      request(app).patch(`/api/v1/crop-stands/${standId}`).send({ spacing_m: null }),
      user,
    )
    expect(contractProblems('/api/v1/crop-stands/{id}', 'patch', 200, standPatched.body)).toEqual(
      [],
    )

    const delPlanting = request(app).delete(`/api/v1/plantings/${plantingId}`)
    expect((await signedIn(delPlanting, user)).status).toBe(204)
    expect(
      (await signedIn(request(app).delete(`/api/v1/crop-stands/${standId}`), user)).status,
    ).toBe(204)
    expect((await signedIn(request(app).delete(`/api/v1/farms/${id}`), user)).status).toBe(204)
  })

  it('sends an empty source as null', async () => {
    const user = await head()
    const planting = await makePlanting(await makeStand(await makeFarm(brgy)))
    const body = (await signedIn(request(app).get(`/api/v1/plantings/${planting._id}`), user))
      .body as unknown
    expect((body as { source: unknown }).source).toBeNull()
  })

  it('refuses a farm with no farmer, or one out of scope', async () => {
    const user = await userWithRole(Role.MAO_VALIDATOR, { municipalityId: gasan._id })
    const hidden = await makeFarmer(boacBrgy)
    for (const body of [{ barangay: brgy._id }, { barangay: brgy._id, farmer: hidden._id }]) {
      const response = await signedIn(request(app).post('/api/v1/farms').send(body), user)
      expect(response.status).toBe(404)
    }
  })

  it('points callers at the right place for nested collections', async () => {
    const user = await userWithRole(Role.PROVINCIAL_ENCODER)
    const checks: [string, 'get' | 'post', string][] = [
      ['/api/v1/crop-stands', 'post', 'use_farm_endpoint'],
      ['/api/v1/plantings', 'get', 'use_crop_stand_endpoint'],
      ['/api/v1/plantings', 'post', 'use_crop_stand_endpoint'],
      ['/api/v1/harvests', 'get', 'use_crop_stand_endpoint'],
      ['/api/v1/harvests', 'post', 'use_crop_stand_endpoint'],
    ]
    for (const [url, method, code] of checks) {
      const response = await signedIn(request(app)[method](url), user)
      expect(response.status).toBe(405)
      expect((response.body as { code: string }).code).toBe(code)
    }
  })

  describe('map points', () => {
    const URL = '/api/v1/farms/points'
    let town: MunicipalityDoc
    let place: BarangayDoc

    beforeAll(async () => {
      town = await makeMunicipality('Points Town')
      place = await makeBarangay(town._id, 'Synthetic Points Barangay')
    })

    function located(barangay = place) {
      return makeFarm(barangay, { location: { type: 'Point', coordinates: [121.9, 13.4] } })
    }

    it('carry coordinates but no names, and count unlocated farms', async () => {
      const farm = await located()
      await makeFarm(place)
      const response = await signedIn(
        request(app).get(`${URL}?municipality=${town._id}`),
        await head(),
      )
      expect(contractProblems(URL, 'get', 200, response.body)).toEqual([])
      const body = response.body as { results: object[]; total_farms: number; located: number }
      expect(body.results).toEqual([
        {
          id: farm._id,
          farmer: farm.farmerId,
          lon: 121.9,
          lat: 13.4,
          barangay: 'Synthetic Points Barangay',
          municipality: 'Points Town',
        },
      ])
      expect([body.total_farms, body.located]).toEqual([2, 1])
    })

    it('leave out a soft-deleted farm', async () => {
      const farm = await Farm.findOne({ _id: (await located())._id })
      if (!farm) throw new Error('no farm')
      markDeleted(farm, null)
      await farm.save()
      const body = (await signedIn(request(app).get(URL), await head())).body as unknown
      expect(JSON.stringify(body)).not.toContain(farm._id)
    })

    it('are refused to a viewer, even with a filter', async () => {
      const viewer = await userWithRole(Role.VIEWER)
      const response = await signedIn(request(app).get(`${URL}?municipality=${town._id}`), viewer)
      expect(response.status).toBe(403)
    })
  })

  describe('setting a location', () => {
    async function patch(id: string, body: object) {
      const user = await userWithRole(Role.PROVINCIAL_ENCODER)
      return signedIn(request(app).patch(`/api/v1/farms/${id}`).send(body), user)
    }

    it('works alone, and is audited masked', async () => {
      const farm = await makeFarm(brgy)
      const response = await patch(farm._id, { location: { lon: 121.95, lat: 13.45 } })
      expect(response.status).toBe(200)
      expect((response.body as { location: object }).location).toEqual({ lon: 121.95, lat: 13.45 })
      const entry = await latestAudit('farm.update', farm._id)
      expect(entry?.after).toEqual({ location: '[personal]' })
      expect(JSON.stringify(entry)).not.toContain('121.95')
    })

    it('can be cleared', async () => {
      const farm = await makeFarm(brgy, { location: { type: 'Point', coordinates: [121.9, 13.4] } })
      const response = await patch(farm._id, { location: null })
      expect(response.status).toBe(200)
      expect((response.body as { location: unknown }).location).toBeNull()
    })

    it('must be within the Philippines', async () => {
      const farm = await makeFarm(brgy)
      expect((await patch(farm._id, { location: { lon: 10, lat: 50 } })).status).toBe(400)
    })
  })
})

describe('harvests', () => {
  let stand: Awaited<ReturnType<typeof makeStand>>
  const url = () => `/api/v1/crop-stands/${stand._id}/harvests`

  beforeAll(async () => {
    stand = await makeStand(await makeFarm(brgy))
  })

  it('without a date are marked estimated, and audited with the buyer masked', async () => {
    const encoderUser = await userWithRole(Role.FIELD_ENCODER, {
      municipalityId: gasan._id,
      barangayIds: [brgy._id],
    })
    const response = await signedIn(
      request(app).post(url()).send({
        quantity: '4.5',
        unit: 'kg',
        product_form: 'dried_beans',
        buyer: 'Synthetic',
      }),
      encoderUser,
    )
    expect(response.status).toBe(201)
    expect(schemaProblems('Harvest', response.body)).toEqual([])
    const body = response.body as { id: string; date_estimated: boolean; quantity: string }
    expect(body.date_estimated).toBe(true)
    expect(body.quantity).toBe('4.500')
    const entry = await latestAudit('harvest.create', body.id)
    expect((entry?.after as { buyer: string }).buyer).toBe('[personal]')
  })

  it('update and soft-delete', async () => {
    const user = await userWithRole(Role.PROVINCIAL_ENCODER)
    const harvest = await makeHarvest(stand, {
      quantity: '6',
      harvestDate: new Date('2025-03-01T00:00:00Z'),
    })
    const path = `/api/v1/harvests/${harvest._id}`
    const patched = await signedIn(request(app).patch(path).send({ quantity: '7' }), user)
    expect(patched.status).toBe(200)
    expect(contractProblems('/api/v1/harvests/{id}', 'patch', 200, patched.body)).toEqual([])
    expect(patched.body).toMatchObject({ quantity: '7.000', harvest_date: '2025-03-01' })

    expect((await signedIn(request(app).delete(path), user)).status).toBe(204)
    expect(await Harvest.exists({ _id: harvest._id })).toBeNull()
    expect(await Harvest.exists({ _id: harvest._id, isDeleted: true })).not.toBeNull()
    expect(await latestAudit('harvest.update', harvest._id)).not.toBeNull()
    expect(await latestAudit('harvest.delete', harvest._id)).not.toBeNull()
  })

  it('list undated first, then newest', async () => {
    const own = await makeStand(await makeFarm(brgy))
    const older = await makeHarvest(own, { harvestDate: new Date('2024-01-01T00:00:00Z') })
    const newer = await makeHarvest(own, { harvestDate: new Date('2025-01-01T00:00:00Z') })
    const undated = await makeHarvest(own)
    const user = await userWithRole(Role.PROVINCIAL_HEAD)
    const response = await signedIn(
      request(app).get(`/api/v1/crop-stands/${own._id}/harvests`),
      user,
    )
    const path = '/api/v1/crop-stands/{id}/harvests'
    expect(contractProblems(path, 'get', 200, response.body)).toEqual([])
    expect((response.body as { id: string }[]).map((row) => row.id)).toEqual([
      undated._id,
      newer._id,
      older._id,
    ])
  })

  it.each([
    [{ quantity: '-1', unit: 'kg' }],
    [{ quantity: 'abc', unit: 'kg' }],
    [{ quantity: '1.2345', unit: 'kg' }],
    [{ quantity: '1', unit: 'tonne' }],
    [{ unit: 'kg' }],
    [{ quantity: '1', unit: 'kg', harvest_date: '2025-13-40' }],
  ])('refuse bad input (%j)', async (body) => {
    const user = await userWithRole(Role.PROVINCIAL_ENCODER)
    const response = await signedIn(request(app).post(url()).send(body), user)
    expect(response.status).toBe(400)
  })

  it('answer 404 from another barangay, and 403 to a viewer', async () => {
    const outsider = await userWithRole(Role.FIELD_ENCODER, {
      municipalityId: boac._id,
      barangayIds: [boacBrgy._id],
    })
    const body = { quantity: '1', unit: 'kg' }
    expect((await signedIn(request(app).post(url()).send(body), outsider)).status).toBe(404)
    const viewer = await userWithRole(Role.VIEWER)
    expect((await signedIn(request(app).post(url()).send(body), viewer)).status).toBe(403)
  })
})
