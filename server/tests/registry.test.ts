import request from 'supertest'
import { beforeAll, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { Role } from '../src/lib/roles.js'
import type { Actor } from '../src/lib/scoping.js'
import { AuditLog } from '../src/models/auditLog.model.js'
import { Farm } from '../src/models/farm.models.js'
import type { BarangayDoc, MunicipalityDoc } from '../src/models/location.models.js'
import { AssociationMember, Farmer, type FarmerDoc } from '../src/models/registry.models.js'
import {
  DUPLICATE_WARN_SIMILARITY,
  findDuplicateFarmers,
  searchRows,
} from '../src/selectors/registry.selectors.js'
import * as services from '../src/services/registry.service.js'
import { contractProblems, schemaProblems } from './support/contract.js'
import {
  actorFor,
  makeAssociation,
  makeBarangay,
  makeFarm,
  makeFarmer,
  makeMember,
  makeMunicipality,
  makeProgram,
  signedIn,
  userWithRole,
} from './support/factories.js'

const app = createApp({ production: false })

let gasan: MunicipalityDoc
let boac: MunicipalityDoc
let brgy: BarangayDoc
let boacBrgy: BarangayDoc
let encoder: Actor
let coordinator: Actor
let admin: Actor

function farmerData(barangay: BarangayDoc, extra: Record<string, unknown> = {}) {
  return { firstName: 'Juana', lastName: 'Sample', homeBarangay: barangay._id, ...extra }
}

async function refreshed(id: string): Promise<FarmerDoc> {
  return (await Farmer.findOne({ _id: id, isDeleted: { $in: [true, false] } }).lean()) as FarmerDoc
}

function latestAudit(action: string, objectId?: string) {
  return AuditLog.findOne({ action, ...(objectId ? { objectId } : {}) })
    .sort({ createdAt: -1 })
    .lean()
}

beforeAll(async () => {
  await Promise.all([Farmer.init(), AssociationMember.init()])
  gasan = await makeMunicipality('Gasan Registry')
  boac = await makeMunicipality('Boac Registry')
  brgy = await makeBarangay(gasan._id, 'Synthetic Gasan One')
  boacBrgy = await makeBarangay(boac._id, 'Synthetic Boac One')
  encoder = await actorFor(await userWithRole(Role.MAO_VALIDATOR, { municipalityId: gasan._id }))
  coordinator = await actorFor(await userWithRole(Role.PROGRAM_COORDINATOR))
  admin = await actorFor(await userWithRole(Role.SYSTEM_ADMIN))
})

describe('createFarmer', () => {
  it('requires consent', async () => {
    const attempt = services.createFarmer({
      actor: encoder,
      data: farmerData(brgy),
      consentGiven: false,
    })
    await expect(attempt).rejects.toMatchObject({ code: 'consent_required' })
  })

  it('records consent and audits without personal values', async () => {
    const farmer = await services.createFarmer({
      actor: encoder,
      data: farmerData(brgy, { contactNo: ' 0917 000 0000 ', rsbsaNo: ' ab-123 ' }),
      consentGiven: true,
    })

    expect(farmer.consentById).toBe(encoder.id)
    expect(farmer.consentAt).not.toBeNull()
    expect(farmer.contactNo).toBe('0917 000 0000')
    expect(farmer.rsbsaNo).toBe('AB-123')
    expect(farmer.normalizedName).toBe('juana sample')
    expect(farmer.municipalityId).toBe(gasan._id)
    const entry = await latestAudit('farmer.create', farmer._id)
    expect(entry?.actorId).toBe(encoder.id)
    const dumped = JSON.stringify(entry?.after)
    expect(dumped).not.toContain('Juana')
    expect(dumped).not.toContain('0917')
    expect((entry?.after as { home_barangay: string }).home_barangay).toBe(brgy._id)
  })

  it('lets imports skip consent', async () => {
    const farmer = await services.createFarmer({
      actor: encoder,
      data: { fullNameRaw: 'Sample, Synthetic', homeBarangay: brgy._id },
      consentGiven: false,
      requireConsent: false,
    })
    expect(farmer.consentAt).toBeNull()
    expect(farmer.fullNameRaw).toBe('Sample, Synthetic')
  })

  it('requires a name', async () => {
    const attempt = services.createFarmer({
      actor: encoder,
      data: { homeBarangay: brgy._id, firstName: '  ' },
      consentGiven: true,
    })
    await expect(attempt).rejects.toMatchObject({ code: 'name_required' })
  })

  it('requires a barangay', async () => {
    const attempt = services.createFarmer({
      actor: encoder,
      data: { lastName: 'Sample' },
      consentGiven: true,
    })
    await expect(attempt).rejects.toMatchObject({ code: 'barangay_required' })
  })

  it('answers 403 for an out-of-scope barangay', async () => {
    const attempt = services.createFarmer({
      actor: encoder,
      data: farmerData(boacBrgy),
      consentGiven: true,
    })
    await expect(attempt).rejects.toMatchObject({ code: 'out_of_scope', status: 403 })
  })

  it('limits a field encoder to assigned barangays', async () => {
    const other = await makeBarangay(gasan._id)
    const user = await userWithRole(Role.FIELD_ENCODER, {
      municipalityId: gasan._id,
      barangayIds: [brgy._id],
    })
    const actor = await actorFor(user)
    await services.createFarmer({ actor, data: farmerData(brgy), consentGiven: true })
    await expect(
      services.createFarmer({ actor, data: farmerData(other), consentGiven: true }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it.each([Role.VIEWER, Role.PROVINCIAL_HEAD, Role.PROGRAM_COORDINATOR])(
    'refuses %s, which cannot edit',
    async (role) => {
      const actor = await actorFor(await userWithRole(role))
      await expect(
        services.createFarmer({ actor, data: farmerData(brgy), consentGiven: true }),
      ).rejects.toMatchObject({ status: 403 })
    },
  )

  it('answers 409 for a duplicate RSBSA number, in any letter case', async () => {
    await makeFarmer(brgy, { rsbsaNo: 'RSBSA-1', consentAt: new Date() })
    const attempt = services.createFarmer({
      actor: encoder,
      data: farmerData(brgy, { rsbsaNo: 'rsbsa-1' }),
      consentGiven: true,
    })
    await expect(attempt).rejects.toMatchObject({ code: 'duplicate_rsbsa', status: 409 })
  })

  it('leaves no audit entry when the write fails', async () => {
    const before = await AuditLog.countDocuments({ action: 'farmer.create' })
    await makeFarmer(brgy, { rsbsaNo: 'RSBSA-ROLLBACK' })
    await services
      .createFarmer({
        actor: encoder,
        data: farmerData(brgy, { rsbsaNo: 'RSBSA-ROLLBACK' }),
        consentGiven: true,
      })
      .catch(() => undefined)
    expect(await AuditLog.countDocuments({ action: 'farmer.create' })).toBe(before)
  })
})

describe('updateFarmer', () => {
  it('needs consent to add contact details when none is recorded', async () => {
    const farmer = await makeFarmer(brgy)
    const data = { contactNo: '0917' }
    await expect(
      services.updateFarmer({ actor: encoder, farmerId: farmer._id, data }),
    ).rejects.toMatchObject({ code: 'consent_required' })

    const updated = await services.updateFarmer({
      actor: encoder,
      farmerId: farmer._id,
      data,
      consentGiven: true,
    })
    expect(updated.consentAt).not.toBeNull()
  })

  it('allows a name fix without consent, and masks it in the audit log', async () => {
    const farmer = await makeFarmer(brgy, { firstName: 'Jaun' })
    await services.updateFarmer({
      actor: encoder,
      farmerId: farmer._id,
      data: { firstName: 'Juan' },
    })
    expect((await refreshed(farmer._id)).firstName).toBe('Juan')
    const entry = await latestAudit('farmer.update', farmer._id)
    expect(entry?.before).toEqual({ first_name: '[personal]' })
    expect(entry?.after).toEqual({ first_name: '[personal]' })
  })

  it('writes no audit entry when nothing changed', async () => {
    const farmer = await makeFarmer(brgy)
    await services.updateFarmer({
      actor: encoder,
      farmerId: farmer._id,
      data: { status: farmer.status },
    })
    expect(await latestAudit('farmer.update', farmer._id)).toBeNull()
  })

  it('cannot move a farmer out of scope', async () => {
    const farmer = await makeFarmer(brgy)
    await expect(
      services.updateFarmer({
        actor: encoder,
        farmerId: farmer._id,
        data: { homeBarangay: boacBrgy._id },
      }),
    ).rejects.toMatchObject({ status: 403 })
    expect((await refreshed(farmer._id)).homeBarangayId).toBe(brgy._id)
  })

  it('keeps the municipality key correct when moved within scope', async () => {
    const farmer = await makeFarmer(brgy)
    const provincial = await actorFor(await userWithRole(Role.PROVINCIAL_ENCODER))
    await services.updateFarmer({
      actor: provincial,
      farmerId: farmer._id,
      data: { homeBarangay: boacBrgy._id },
    })
    const after = await refreshed(farmer._id)
    expect([after.homeBarangayId, after.municipalityId]).toEqual([boacBrgy._id, boac._id])
  })
})

describe('deleteFarmer', () => {
  it('is blocked while farms exist', async () => {
    const farm = await makeFarm(brgy)
    await expect(
      services.deleteFarmer({ actor: encoder, farmerId: farm.farmerId }),
    ).rejects.toMatchObject({ code: 'has_farms', status: 409 })
  })

  it('soft-deletes the farmer and memberships', async () => {
    const farmer = await makeFarmer(brgy)
    const association = await makeAssociation(gasan._id)
    const member = await makeMember(farmer._id, association._id)

    await services.deleteFarmer({ actor: encoder, farmerId: farmer._id })

    expect(await Farmer.exists({ _id: farmer._id })).toBeNull()
    expect((await refreshed(farmer._id)).deletedBy).toBe(encoder.id)
    expect(await AssociationMember.exists({ _id: member._id })).toBeNull()
    expect(await latestAudit('farmer.delete', farmer._id)).not.toBeNull()
  })
})

describe('mergeFarmers', () => {
  it('moves farms and memberships and fills blanks', async () => {
    const target = await makeFarmer(brgy, { contactNo: '', sex: 'male' })
    const duplicate = await makeFarmer(brgy, {
      contactNo: '0917',
      rsbsaNo: 'R-9',
      sex: 'female',
      birthYear: 1970,
    })
    await makeFarm(brgy, { farmerId: duplicate._id })
    await makeFarm(brgy, { farmerId: duplicate._id })
    const shared = await makeAssociation(gasan._id)
    await makeMember(target._id, shared._id)
    await makeMember(duplicate._id, shared._id)
    await makeMember(duplicate._id, (await makeAssociation(gasan._id))._id)

    const result = await services.mergeFarmers({
      actor: coordinator,
      targetId: target._id,
      duplicateId: duplicate._id,
    })

    expect(result.farmsMoved).toBe(2)
    expect(result.membershipsMoved).toBe(1)
    expect([...result.fieldsFilled].sort()).toEqual(['birth_year', 'contact_no', 'rsbsa_no'])
    expect(result.conflicts).toEqual(['sex'])
    const after = await refreshed(target._id)
    expect([after.rsbsaNo, after.contactNo, after.sex]).toEqual(['R-9', '0917', 'male'])
    expect(await Farm.countDocuments({ farmerId: target._id })).toBe(2)
    expect(await AssociationMember.countDocuments({ farmerId: target._id })).toBe(2)
    const retired = await refreshed(duplicate._id)
    expect(retired.isDeleted).toBe(true)
    expect(retired.mergedIntoId).toBe(target._id)
    expect(retired.status).toBe('inactive')
    expect(retired.rsbsaNo).toBeNull()
    expect(await latestAudit('farmer.merge', target._id)).not.toBeNull()
    expect(await latestAudit('farmer.merged_into', duplicate._id)).not.toBeNull()
  })

  it('keeps the older consent when the target has none', async () => {
    const consentAt = new Date('2024-01-01T00:00:00Z')
    const target = await makeFarmer(brgy)
    const duplicate = await makeFarmer(brgy, { consentAt, consentById: encoder.id })
    await services.mergeFarmers({
      actor: coordinator,
      targetId: target._id,
      duplicateId: duplicate._id,
    })
    const after = await refreshed(target._id)
    expect(after.consentAt).toEqual(consentAt)
    expect(after.consentById).toBe(encoder.id)
  })

  it('requires the merge capability', async () => {
    const [a, b] = [await makeFarmer(brgy), await makeFarmer(brgy)]
    await expect(
      services.mergeFarmers({ actor: encoder, targetId: a._id, duplicateId: b._id }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('refuses merging a farmer into itself', async () => {
    const a = await makeFarmer(brgy)
    await expect(
      services.mergeFarmers({ actor: coordinator, targetId: a._id, duplicateId: a._id }),
    ).rejects.toMatchObject({ code: 'merge_self' })
  })

  it('rolls everything back if a later step fails', async () => {
    const target = await makeFarmer(brgy)
    const duplicate = await makeFarmer(brgy, { birthYear: 1970 })
    const farm = await makeFarm(brgy, { farmerId: duplicate._id })
    // A value the model refuses only when the target is saved, after farms have moved.
    await Farmer.collection.updateOne({ _id: target._id as never }, { $set: { sex: 'unknown' } })

    await expect(
      services.mergeFarmers({
        actor: coordinator,
        targetId: target._id,
        duplicateId: duplicate._id,
      }),
    ).rejects.toThrow()

    expect((await Farm.findOne({ _id: farm._id }).lean())?.farmerId).toBe(duplicate._id)
    expect((await refreshed(duplicate._id)).isDeleted).toBe(false)
    expect(await latestAudit('farmer.merge', target._id)).toBeNull()
  })
})

describe('eraseFarmerPersonalData', () => {
  it('blanks personal data and keeps the record', async () => {
    const farmer = await makeFarmer(brgy, {
      contactNo: '0917',
      rsbsaNo: 'R-ERASE',
      birthYear: 1960,
      fullNameRaw: 'Sample Raw',
    })
    const farm = await makeFarm(brgy, {
      farmerId: farmer._id,
      sitio: 'Synthetic sitio',
      locationRaw: 'near the river',
      location: { type: 'Point', coordinates: [121.9, 13.4] },
    })

    await services.eraseFarmerPersonalData({ actor: admin, farmerId: farmer._id })

    const after = await refreshed(farmer._id)
    expect([after.firstName, after.lastName, after.fullNameRaw]).toEqual(['', '', '[erased]'])
    expect([after.contactNo, after.rsbsaNo, after.birthYear]).toEqual(['', null, null])
    expect(after.normalizedName).toBe('erased')
    const farmAfter = await Farm.findOne({ _id: farm._id }).lean()
    expect([farmAfter?.sitio, farmAfter?.locationRaw, farmAfter?.location]).toEqual(['', '', null])
    expect(await latestAudit('farmer.erase', farmer._id)).not.toBeNull()
  })

  it('is admin only', async () => {
    const farmer = await makeFarmer(brgy)
    await expect(
      services.eraseFarmerPersonalData({ actor: encoder, farmerId: farmer._id }),
    ).rejects.toMatchObject({ status: 403 })
  })
})

describe('associations', () => {
  it('create, update and delete, with audit entries', async () => {
    const association = await services.createAssociation({
      actor: encoder,
      data: { name: '  Sample  Gasan FA ', municipality: gasan._id },
    })
    expect(association.name).toBe('Sample Gasan FA')

    await services.updateAssociation({
      actor: encoder,
      associationId: association._id,
      data: { shortName: 'SGFA' },
    })
    expect(await latestAudit('association.update', association._id)).not.toBeNull()

    await services.deleteAssociation({ actor: encoder, associationId: association._id })
    expect(await latestAudit('association.delete', association._id)).not.toBeNull()
  })

  it('answers 409 for a duplicate name in the municipality', async () => {
    const data = { name: 'Sample FA Unique', municipality: gasan._id }
    await services.createAssociation({ actor: encoder, data })
    await expect(
      services.createAssociation({
        actor: encoder,
        data: { name: 'sample fa unique.', municipality: gasan._id },
      }),
    ).rejects.toMatchObject({ code: 'duplicate_association', status: 409 })
  })

  it('requires a name', async () => {
    await expect(
      services.createAssociation({ actor: encoder, data: { name: ' ', municipality: gasan._id } }),
    ).rejects.toMatchObject({ code: 'name_required' })
  })

  it('refuses an out-of-scope municipality', async () => {
    await expect(
      services.createAssociation({ actor: encoder, data: { name: 'X', municipality: boac._id } }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('manage members', async () => {
    const association = await makeAssociation(gasan._id)
    const farmer = await makeFarmer(brgy)
    const add = { actor: encoder, associationId: association._id, farmerId: farmer._id }

    const memberId = await services.addMember({ ...add, role: ' Pres ' })
    expect((await AssociationMember.findOne({ _id: memberId }).lean())?.role).toBe('Pres')
    await expect(services.addMember(add)).rejects.toMatchObject({ code: 'already_member' })
    await expect(
      services.deleteAssociation({ actor: encoder, associationId: association._id }),
    ).rejects.toMatchObject({ code: 'has_members' })

    await services.removeMember({ actor: encoder, associationId: association._id, memberId })
    expect(await AssociationMember.exists({ associationId: association._id })).toBeNull()
    await services.addMember(add) // a removed member can rejoin
  })
})

describe('duplicate search', () => {
  let town: BarangayDoc
  beforeAll(async () => {
    town = await makeBarangay((await makeMunicipality('Duplicates Town'))._id)
  })

  function inTown(name: string, threshold?: number) {
    return findDuplicateFarmers(
      {},
      { name, municipalityId: town.municipalityId, ...(threshold ? { threshold } : {}) },
    )
  }

  it('treats abbreviations as exact matches', async () => {
    const existing = await makeFarmer(town, { firstName: 'Maria Luisa', lastName: 'Samplereyes' })
    const found = await inTown('Ma. Luisa Samplereyes', DUPLICATE_WARN_SIMILARITY)
    expect(found.map((c) => [c.farmer._id, c.similarity, c.reason])).toEqual([
      [existing._id, 1, 'name'],
    ])
  })

  it('finds a typo at the suggest threshold but not at the warn threshold', async () => {
    const name = 'Maria Luiza Samplereyez'
    const suggest = await inTown(name)
    expect(suggest).toHaveLength(1)
    expect(suggest[0]?.similarity).toBeGreaterThanOrEqual(0.6)
    expect(suggest[0]?.similarity).toBeLessThan(0.85)
    expect(await inTown(name, DUPLICATE_WARN_SIMILARITY)).toEqual([])
  })

  it('limits name matches to the municipality', async () => {
    await makeFarmer(boacBrgy, { firstName: 'Pedro', lastName: 'Sampleton' })
    expect(await inTown('Pedro Sampleton')).toEqual([])
  })

  it('matches an RSBSA number anywhere, and honours exclude', async () => {
    const same = await makeFarmer(boacBrgy, { rsbsaNo: 'R-77', lastName: 'Different' })
    const editing = await makeFarmer(town, { lastName: 'Sampletonian' })
    const found = await findDuplicateFarmers(
      {},
      {
        name: 'Pedro Sampletonian',
        municipalityId: town.municipalityId,
        rsbsaNo: ' r-77 ',
        excludeId: editing._id,
      },
    )
    expect(found.map((c) => [c.farmer._id, c.reason])).toEqual([[same._id, 'rsbsa']])
  })

  it('searches tolerate variants, and find by RSBSA', () => {
    const rows = [
      { normalizedName: 'rosa sampleira', rsbsaNo: null },
      { normalizedName: 'rosa sampleiro', rsbsaNo: null },
      { normalizedName: 'pedro unrelated', rsbsaNo: '17-40-01-001' },
    ]
    const found = searchRows(rows, 'rosa sampleira')
    expect(found.map((row) => row.normalizedName)).toEqual(['rosa sampleira', 'rosa sampleiro'])
    expect(searchRows(rows, '17-40-01-001').map((row) => row.rsbsaNo)).toEqual(['17-40-01-001'])
  })
})

describe('races between checks and writes', () => {
  it('never leaves a farm under a deleted farmer', async () => {
    for (let round = 0; round < 5; round += 1) {
      const farmer = await makeFarmer(brgy)
      const results = await Promise.allSettled([
        services.deleteFarmer({ actor: encoder, farmerId: farmer._id }),
        import('../src/services/farm.service.js').then(({ createFarm }) =>
          createFarm({ actor: encoder, farmerId: farmer._id, data: { barangay: brgy._id } }),
        ),
      ])
      const alive = await Farmer.exists({ _id: farmer._id })
      const farms = await Farm.countDocuments({ farmerId: farmer._id })
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(Boolean(alive)).toBe(farms === 1)
    }
  })

  it('merges in both directions without losing either farmer', async () => {
    const a = await makeFarmer(brgy)
    const b = await makeFarmer(brgy)
    const results = await Promise.allSettled([
      services.mergeFarmers({ actor: coordinator, targetId: a._id, duplicateId: b._id }),
      services.mergeFarmers({ actor: coordinator, targetId: b._id, duplicateId: a._id }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const alive = await Farmer.countDocuments({ _id: { $in: [a._id, b._id] } })
    expect(alive).toBe(1)
  })
})

describe('the farmers API', () => {
  async function asRole(role: Role) {
    return userWithRole(role, role === Role.MAO_VALIDATOR ? { municipalityId: gasan._id } : {})
  }

  it('lists to the contract, with filters', async () => {
    const town = await makeBarangay(gasan._id, 'Synthetic Filter Barangay')
    const wanted = await makeFarmer(town, { firstName: 'Filtered', lastName: 'Sampleone' })
    const user = await asRole(Role.PROVINCIAL_HEAD)
    const response = await signedIn(
      request(app).get(`/api/v1/farmers?barangay=${town._id}&municipality=`),
      user,
    )
    expect(response.status).toBe(200)
    expect(contractProblems('/api/v1/farmers', 'get', 200, response.body)).toEqual([])
    const body = response.body as { results: { id: string }[] }
    expect(body.results.map((row) => row.id)).toEqual([wanted._id])
  })

  it('searches and sorts', async () => {
    const town = await makeBarangay(gasan._id, 'Synthetic Search Barangay')
    const exact = await makeFarmer(town, { firstName: 'Rosa', lastName: 'Sampleira' })
    const near = await makeFarmer(town, { firstName: 'Rosa', lastName: 'Sampleiro' })
    await makeFarmer(town, { firstName: 'Pedro', lastName: 'Unrelated' })
    const user = await asRole(Role.PROVINCIAL_HEAD)
    const ids = async (query: string) => {
      const url = `/api/v1/farmers?barangay=${town._id}&${query}`
      const body = (await signedIn(request(app).get(url), user)).body as unknown
      return (body as { results: { id: string }[] }).results.map((row) => row.id)
    }
    expect(await ids('q=rosa%20sampleira')).toEqual([exact._id, near._id])
    expect(await ids('q=rosa%20sampleira&ordering=-last_name')).toEqual([near._id, exact._id])
    expect(await ids('page_size=1&ordering=last_name')).toEqual([exact._id])
  })

  it('filters by association and refuses bad filters', async () => {
    const association = await makeAssociation(gasan._id)
    const member = await makeFarmer(brgy)
    await makeMember(member._id, association._id)
    const user = await asRole(Role.PROVINCIAL_HEAD)
    const response = await signedIn(
      request(app).get(`/api/v1/farmers?association=${association._id}`),
      user,
    )
    expect((response.body as { results: { id: string }[] }).results.map((row) => row.id)).toEqual([
      member._id,
    ])
    for (const query of ['status=nonsense', 'barangay=abc']) {
      const refused = await signedIn(request(app).get(`/api/v1/farmers?${query}`), user)
      expect(refused.status).toBe(400)
    }
  })

  it('never lets a search or filter widen the scope', async () => {
    const hidden = await makeFarmer(boacBrgy, { firstName: 'Hidden', lastName: 'Sampleboac' })
    const user = await asRole(Role.MAO_VALIDATOR)
    const urls = [
      '/api/v1/farmers?q=hidden%20sampleboac',
      `/api/v1/farmers?municipality=${boac._id}`,
      `/api/v1/farmers?barangay=${boacBrgy._id}`,
    ]
    for (const url of urls) {
      const body = (await signedIn(request(app).get(url), user)).body as unknown
      expect(JSON.stringify(body)).not.toContain(hidden._id)
    }
    const duplicates = await signedIn(
      request(app).get(`/api/v1/farmers/duplicates?name=Hidden%20Sampleboac`),
      user,
    )
    expect(duplicates.body).toEqual([])
  })

  it('creates, reads, updates and deletes to the contract', async () => {
    const user = await asRole(Role.MAO_VALIDATOR)
    const created = await signedIn(
      request(app).post('/api/v1/farmers').send({
        first_name: 'Test',
        last_name: 'Sampleapi',
        home_barangay: brgy._id,
        consent_given: true,
        sex: '',
        not_a_field: 'ignored',
      }),
      user,
    )
    expect(created.status).toBe(201)
    expect(contractProblems('/api/v1/farmers', 'post', 201, created.body)).toEqual([])
    const { id } = created.body as { id: string }

    const detail = await signedIn(request(app).get(`/api/v1/farmers/${id}`), user)
    expect(contractProblems('/api/v1/farmers/{id}', 'get', 200, detail.body)).toEqual([])

    const patched = await signedIn(
      request(app).patch(`/api/v1/farmers/${id}`).send({ middle_name: 'Mid' }),
      user,
    )
    expect(patched.status).toBe(200)
    expect(contractProblems('/api/v1/farmers/{id}', 'patch', 200, patched.body)).toEqual([])
    expect((patched.body as { display_name: string }).display_name).toBe('Test Mid Sampleapi')

    const noBarangay = await signedIn(
      request(app).put(`/api/v1/farmers/${id}`).send({ first_name: 'X' }),
      user,
    )
    expect(noBarangay.status).toBe(400)

    const audit = await signedIn(request(app).get(`/api/v1/farmers/${id}/audit`), user)
    expect(contractProblems('/api/v1/farmers/{id}/audit', 'get', 200, audit.body)).toEqual([])

    expect((await signedIn(request(app).delete(`/api/v1/farmers/${id}`), user)).status).toBe(204)
    expect((await signedIn(request(app).get(`/api/v1/farmers/${id}`), user)).status).toBe(404)
  })

  it('validates input', async () => {
    const user = await asRole(Role.MAO_VALIDATOR)
    const post = (body: object) => signedIn(request(app).post('/api/v1/farmers').send(body), user)
    const base = { last_name: 'Sample', home_barangay: brgy._id, consent_given: true }
    for (const bad of [
      { ...base, birth_year: 1800 },
      { ...base, sex: 'other' },
      { ...base, home_barangay: 'abc' },
      { ...base, home_barangay: '00000000-0000-4000-8000-000000000000' },
      { ...base, first_name: 'x'.repeat(101) },
    ]) {
      expect((await post(bad)).status).toBe(400)
    }
    const fields = ((await post({ ...base, sex: 'other' })).body as { fields: object }).fields
    expect(fields).toHaveProperty('sex')
  })

  it('finds duplicates to the contract', async () => {
    const town = await makeBarangay(gasan._id, 'Synthetic Duplicate Barangay')
    await makeFarmer(town, { firstName: 'Duplicate', lastName: 'Samplefind' })
    const user = await asRole(Role.MAO_VALIDATOR)
    const url = `/api/v1/farmers/duplicates?name=Duplicate%20Samplefind&barangay=${town._id}`
    const response = await signedIn(request(app).get(url), user)
    expect(response.status).toBe(200)
    expect(response.body).toHaveLength(1)
    expect(contractProblems('/api/v1/farmers/duplicates', 'get', 200, response.body)).toEqual([])
    const unknown = `/api/v1/farmers/duplicates?name=x&barangay=not-a-real-id`
    expect((await signedIn(request(app).get(unknown), user)).status).toBe(404)
  })

  it('merges to the contract, and hides an out-of-scope duplicate', async () => {
    const coordinatorUser = await asRole(Role.PROGRAM_COORDINATOR)
    const target = await makeFarmer(brgy)
    const duplicate = await makeFarmer(brgy)
    const response = await signedIn(
      request(app).post(`/api/v1/farmers/${target._id}/merge`).send({ duplicate: duplicate._id }),
      coordinatorUser,
    )
    expect(response.status).toBe(200)
    expect(contractProblems('/api/v1/farmers/{id}/merge', 'post', 200, response.body)).toEqual([])

    const scoped = await userWithRole(Role.PROGRAM_COORDINATOR, {
      programId: (await makeProgram())._id,
    })
    const missing = await signedIn(
      request(app)
        .post(`/api/v1/farmers/${target._id}/merge`)
        .send({ duplicate: '00000000-0000-4000-8000-000000000000' }),
      scoped,
    )
    expect(missing.status).toBe(404)
    expect((missing.body as { fields: object }).fields).toHaveProperty('duplicate')

    const validator = await asRole(Role.MAO_VALIDATOR)
    const refused = await signedIn(
      request(app).post(`/api/v1/farmers/${target._id}/merge`).send({ duplicate: duplicate._id }),
      validator,
    )
    expect(refused.status).toBe(403)
  })
})

describe('the associations API', () => {
  it('works to the contract, counting only live members', async () => {
    const user = await userWithRole(Role.MAO_VALIDATOR, { municipalityId: gasan._id })
    const created = await signedIn(
      request(app)
        .post('/api/v1/associations')
        .send({ name: 'Sample Api Association', municipality: gasan._id }),
      user,
    )
    expect(created.status).toBe(201)
    expect(contractProblems('/api/v1/associations', 'post', 201, created.body)).toEqual([])
    const { id } = created.body as { id: string }

    const farmer = await makeFarmer(brgy)
    const added = await signedIn(
      request(app)
        .post(`/api/v1/associations/${id}/members`)
        .send({ farmer: farmer._id, role: 'Treasurer', since: '2020-02-03' }),
      user,
    )
    expect(added.status).toBe(201)
    expect(schemaProblems('Member', added.body)).toEqual([])
    expect((added.body as { since: string }).since).toBe('2020-02-03')

    const farmerDetail = await signedIn(request(app).get(`/api/v1/farmers/${farmer._id}`), user)
    expect((farmerDetail.body as { memberships: unknown[] }).memberships).toHaveLength(1)
    expect(contractProblems('/api/v1/farmers/{id}', 'get', 200, farmerDetail.body)).toEqual([])

    const members = await signedIn(request(app).get(`/api/v1/associations/${id}/members`), user)
    const path = '/api/v1/associations/{id}/members'
    expect(contractProblems(path, 'get', 200, members.body)).toEqual([])

    const detail = await signedIn(request(app).get(`/api/v1/associations/${id}`), user)
    expect((detail.body as { member_count: number }).member_count).toBe(1)

    const { id: memberId } = added.body as { id: string }
    const removed = await signedIn(
      request(app).delete(`/api/v1/associations/${id}/members/${memberId}`),
      user,
    )
    expect(removed.status).toBe(204)
    const after = await signedIn(request(app).get(`/api/v1/associations/${id}`), user)
    expect((after.body as { member_count: number }).member_count).toBe(0)

    const list = await signedIn(request(app).get('/api/v1/associations?q=api%20association'), user)
    expect(contractProblems('/api/v1/associations', 'get', 200, list.body)).toEqual([])
    expect((list.body as { count: number }).count).toBe(1)
  })

  it('hides a farmer the requester cannot see when adding a member', async () => {
    const user = await userWithRole(Role.MAO_VALIDATOR, { municipalityId: gasan._id })
    const association = await makeAssociation(gasan._id)
    const hidden = await makeFarmer(boacBrgy)
    const response = await signedIn(
      request(app).post(`/api/v1/associations/${association._id}/members`).send({
        farmer: hidden._id,
      }),
      user,
    )
    expect(response.status).toBe(404)
  })

  it('cannot remove a member through another association', async () => {
    const user = await userWithRole(Role.MAO_VALIDATOR, { municipalityId: gasan._id })
    const [first, second] = [await makeAssociation(gasan._id), await makeAssociation(gasan._id)]
    const member = await makeMember((await makeFarmer(brgy))._id, first._id)
    const response = await signedIn(
      request(app).delete(`/api/v1/associations/${second._id}/members/${member._id}`),
      user,
    )
    expect(response.status).toBe(404)
  })
})
