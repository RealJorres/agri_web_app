/** Registry writes. Every change is scope-checked against the actor and audited (PII masked). */
import type { ClientSession, HydratedDocument } from 'mongoose'

import { parseDateOnly } from '../lib/dates.js'
import { DomainError, notFound } from '../lib/errors.js'
import { isDuplicateKey } from '../lib/mongoErrors.js'
import { Cap } from '../lib/roles.js'
import { requireReach, scopeFilter, within, type Actor } from '../lib/scoping.js'
import { collapseSpaces } from '../lib/text.js'
import { inTransaction } from '../lib/transaction.js'
import { lockForWrite, markDeleted } from '../models/base.js'
import { Farm } from '../models/farm.models.js'
import { Barangay, Municipality, type BarangayDoc } from '../models/location.models.js'
import {
  Association,
  ASSOCIATION_SCOPE,
  AssociationMember,
  type AssociationDoc,
  Farmer,
  FARMER_PERSONAL_FIELDS,
  FARMER_SCOPE,
  type FarmerDoc,
} from '../models/registry.models.js'
import type { AssociationValues, FarmerValues } from '../validators/registry.validators.js'
import { changes, mask, recordAudit } from './audit.service.js'

function invalidReference(field: string): DomainError {
  return new DomainError('validation_error', 'Some fields are invalid.', {
    [field]: ['This does not exist.'],
  })
}

async function barangayOr400(
  id: string,
  field: string,
  session: ClientSession,
): Promise<BarangayDoc> {
  const barangay = await Barangay.findOne({ _id: id }).session(session).lean<BarangayDoc>()
  if (!barangay) throw invalidReference(field)
  return barangay
}

function reachOf(barangay: BarangayDoc) {
  return { barangayId: barangay._id, municipalityId: barangay.municipalityId }
}

// --- Farmers

const CONSENT_FIELDS = ['rsbsa_no', 'contact_no', 'birth_year', 'sex'] as const

type FarmerDocument = HydratedDocument<FarmerDoc>

function farmerSnapshot(farmer: FarmerDoc): Record<string, unknown> {
  return {
    first_name: farmer.firstName,
    middle_name: farmer.middleName,
    last_name: farmer.lastName,
    suffix: farmer.suffix,
    full_name_raw: farmer.fullNameRaw,
    sex: farmer.sex,
    birth_year: farmer.birthYear,
    rsbsa_no: farmer.rsbsaNo,
    contact_no: farmer.contactNo,
    home_barangay: farmer.homeBarangayId,
    status: farmer.status,
  }
}

function assignFarmerValues(farmer: FarmerDocument, data: FarmerValues): void {
  if (data.firstName !== undefined) farmer.firstName = collapseSpaces(data.firstName)
  if (data.middleName !== undefined) farmer.middleName = collapseSpaces(data.middleName)
  if (data.lastName !== undefined) farmer.lastName = collapseSpaces(data.lastName)
  if (data.suffix !== undefined) farmer.suffix = collapseSpaces(data.suffix)
  if (data.fullNameRaw !== undefined) farmer.fullNameRaw = collapseSpaces(data.fullNameRaw)
  if (data.sex !== undefined) farmer.sex = data.sex
  if (data.birthYear !== undefined) farmer.birthYear = data.birthYear
  if (data.rsbsaNo !== undefined) {
    farmer.rsbsaNo = collapseSpaces(data.rsbsaNo).toUpperCase() || null
  }
  if (data.contactNo !== undefined) farmer.contactNo = collapseSpaces(data.contactNo)
  if (data.status !== undefined) farmer.status = data.status
}

function checkName(farmer: FarmerDoc): void {
  if (!(farmer.firstName || farmer.lastName || farmer.fullNameRaw)) {
    throw new DomainError('name_required', "Enter the farmer's name.", {
      last_name: ['This field is required.'],
    })
  }
}

function applyConsent(farmer: FarmerDoc, actor: Actor, consentGiven: boolean): void {
  if (consentGiven) {
    farmer.consentAt = new Date()
    farmer.consentById = actor.id
    return
  }
  const values = farmerSnapshot(farmer)
  const captured = CONSENT_FIELDS.filter((field) => {
    const value = values[field]
    return value !== null && value !== ''
  })
  if (captured.length > 0 && farmer.consentAt === null) {
    throw new DomainError(
      'consent_required',
      'Record the farmer’s consent before saving contact or identity details.',
      { consent_given: [`Consent is required for: ${captured.join(', ')}`] },
    )
  }
}

async function saveFarmer(farmer: FarmerDocument, session: ClientSession): Promise<void> {
  try {
    await farmer.save({ session })
  } catch (error) {
    if (isDuplicateKey(error, 'rsbsaNo')) {
      throw new DomainError(
        'duplicate_rsbsa',
        'Another farmer already has this RSBSA number.',
        { rsbsa_no: ['Already registered to another farmer.'] },
        409,
      )
    }
    throw error
  }
}

async function farmerInScope(
  actor: Actor,
  id: string,
  session: ClientSession,
): Promise<FarmerDocument | null> {
  const visible = scopeFilter(actor.scope, Cap.VIEW_RECORDS, FARMER_SCOPE)
  return Farmer.findOne(within(visible, { _id: id })).session(session)
}

/**
 * Office and field forms must capture consent. Imports pass requireConsent: false and leave the
 * consent date empty.
 */
export async function createFarmer({
  actor,
  data,
  consentGiven,
  requireConsent = true,
}: {
  actor: Actor
  data: FarmerValues
  consentGiven: boolean
  requireConsent?: boolean
}): Promise<FarmerDoc> {
  return inTransaction(async (session) => {
    if (data.homeBarangay === undefined) {
      throw new DomainError('barangay_required', 'Choose the home barangay.', {
        home_barangay: ['Required.'],
      })
    }
    const barangay = await barangayOr400(data.homeBarangay, 'home_barangay', session)
    requireReach(actor.scope, Cap.EDIT_RECORDS, reachOf(barangay), 'home_barangay')
    if (requireConsent && !consentGiven) {
      throw new DomainError(
        'consent_required',
        'Show the privacy notice and record the farmer’s consent.',
        { consent_given: ['Consent is required to register a farmer.'] },
      )
    }
    const farmer: FarmerDocument = new Farmer({
      homeBarangayId: barangay._id,
      municipalityId: barangay.municipalityId,
      createdBy: actor.id,
      updatedBy: actor.id,
    })
    assignFarmerValues(farmer, data)
    checkName(farmer)
    if (requireConsent || consentGiven) applyConsent(farmer, actor, consentGiven)
    await saveFarmer(farmer, session)
    await recordAudit({
      actorId: actor.id,
      action: 'farmer.create',
      objectType: 'farmer',
      objectId: farmer._id,
      after: mask(farmerSnapshot(farmer), FARMER_PERSONAL_FIELDS),
      session,
    })
    return farmer.toObject()
  })
}

export async function updateFarmer({
  actor,
  farmerId,
  data,
  consentGiven = false,
}: {
  actor: Actor
  farmerId: string
  data: FarmerValues
  consentGiven?: boolean
}): Promise<FarmerDoc> {
  return inTransaction(async (session) => {
    const farmer = await farmerInScope(actor, farmerId, session)
    if (!farmer) throw notFound()
    requireReach(
      actor.scope,
      Cap.EDIT_RECORDS,
      { barangayId: farmer.homeBarangayId, municipalityId: farmer.municipalityId },
      'home_barangay',
    )
    const before = farmerSnapshot(farmer)
    assignFarmerValues(farmer, data)
    if (data.homeBarangay !== undefined) {
      const barangay = await barangayOr400(data.homeBarangay, 'home_barangay', session)
      requireReach(actor.scope, Cap.EDIT_RECORDS, reachOf(barangay), 'home_barangay')
      farmer.homeBarangayId = barangay._id
      farmer.municipalityId = barangay.municipalityId
    }
    checkName(farmer)
    applyConsent(farmer, actor, consentGiven)
    farmer.updatedBy = actor.id
    await saveFarmer(farmer, session)
    const diff = changes(before, farmerSnapshot(farmer), FARMER_PERSONAL_FIELDS)
    if (consentGiven) diff.after.consent_at = farmer.consentAt?.toISOString() ?? null
    if (Object.keys(diff.after).length > 0) {
      await recordAudit({
        actorId: actor.id,
        action: 'farmer.update',
        objectType: 'farmer',
        objectId: farmer._id,
        before: diff.before,
        after: diff.after,
        session,
      })
    }
    return farmer.toObject()
  })
}

export async function deleteFarmer({
  actor,
  farmerId,
}: {
  actor: Actor
  farmerId: string
}): Promise<void> {
  await inTransaction(async (session) => {
    const farmer = await farmerInScope(actor, farmerId, session)
    if (!farmer) throw notFound()
    requireReach(
      actor.scope,
      Cap.EDIT_RECORDS,
      { barangayId: farmer.homeBarangayId, municipalityId: farmer.municipalityId },
      'home_barangay',
    )
    // This transaction also writes the farmer, so a farm being added right now conflicts with it.
    if (await Farm.exists({ farmerId: farmer._id }).session(session)) {
      throw new DomainError(
        'has_farms',
        'This farmer still has farms. Delete or merge them first.',
        {},
        409,
      )
    }
    const memberships = await AssociationMember.find({ farmerId: farmer._id }).session(session)
    for (const membership of memberships) {
      markDeleted(membership, actor.id)
      await membership.save({ session })
    }
    markDeleted(farmer, actor.id)
    await farmer.save({ session })
    await recordAudit({
      actorId: actor.id,
      action: 'farmer.delete',
      objectType: 'farmer',
      objectId: farmer._id,
      session,
    })
  })
}

export interface MergeResult {
  targetId: string
  farmsMoved: number
  membershipsMoved: number
  fieldsFilled: string[]
  /** Fields where both farmers had different values. The target's value is kept. */
  conflicts: string[]
}

const MERGE_FILL_FIELDS = [
  ['middle_name', 'middleName'],
  ['suffix', 'suffix'],
  ['sex', 'sex'],
  ['birth_year', 'birthYear'],
  ['rsbsa_no', 'rsbsaNo'],
  ['contact_no', 'contactNo'],
] as const

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === ''
}

/**
 * Folds a duplicate into a target: farms and memberships move, blank target fields are filled from
 * the duplicate (the target wins on conflicts), and the duplicate is retired. A farm's location
 * keys belong to the farm, so they do not change.
 */
export async function mergeFarmers({
  actor,
  targetId,
  duplicateId,
}: {
  actor: Actor
  targetId: string
  duplicateId: string
}): Promise<MergeResult> {
  return inTransaction(async (session) => {
    const target = await farmerInScope(actor, targetId, session)
    if (!target) throw notFound()
    const duplicate = await farmerInScope(actor, duplicateId, session)
    if (!duplicate) {
      throw new DomainError(
        'not_found',
        'Duplicate farmer not found.',
        { duplicate: ['Not found.'] },
        404,
      )
    }
    for (const [farmer, field] of [
      [target, 'target'],
      [duplicate, 'duplicate'],
    ] as const) {
      requireReach(
        actor.scope,
        Cap.MERGE_FARMERS,
        { barangayId: farmer.homeBarangayId, municipalityId: farmer.municipalityId },
        field,
      )
    }
    if (target._id === duplicate._id) {
      throw new DomainError('merge_self', 'Choose two different farmers.')
    }

    const moved = await Farm.updateMany(
      { farmerId: duplicate._id },
      { farmerId: target._id, updatedBy: actor.id },
      { session },
    )
    const result: MergeResult = {
      targetId: target._id,
      farmsMoved: moved.modifiedCount,
      membershipsMoved: 0,
      fieldsFilled: [],
      conflicts: [],
    }

    const ours = await AssociationMember.find({ farmerId: target._id }).session(session).lean()
    const existing = new Set(ours.map((member) => member.associationId))
    const theirs = await AssociationMember.find({ farmerId: duplicate._id }).session(session)
    for (const membership of theirs) {
      if (existing.has(membership.associationId)) {
        markDeleted(membership, actor.id)
      } else {
        membership.farmerId = target._id
        membership.updatedBy = actor.id
        result.membershipsMoved += 1
      }
      await membership.save({ session })
    }

    const movedRsbsa = duplicate.rsbsaNo
    duplicate.rsbsaNo = null // frees the unique value before it is copied
    duplicate.status = 'inactive'
    duplicate.mergedIntoId = target._id
    markDeleted(duplicate, actor.id)
    await duplicate.save({ session })

    for (const [apiName, field] of MERGE_FILL_FIELDS) {
      const incoming = field === 'rsbsaNo' ? movedRsbsa : duplicate[field]
      if (isBlank(incoming)) continue
      if (isBlank(target[field])) {
        target.set(field, incoming)
        result.fieldsFilled.push(apiName)
      } else if (target[field] !== incoming) {
        result.conflicts.push(apiName)
      }
    }
    if (target.consentAt === null && duplicate.consentAt !== null) {
      target.consentAt = duplicate.consentAt
      target.consentById = duplicate.consentById
    }
    target.updatedBy = actor.id
    await saveFarmer(target, session)

    await recordAudit({
      actorId: actor.id,
      action: 'farmer.merge',
      objectType: 'farmer',
      objectId: target._id,
      after: {
        duplicate: duplicate._id,
        farms_moved: result.farmsMoved,
        memberships_moved: result.membershipsMoved,
        fields_filled: result.fieldsFilled,
        conflicts: result.conflicts,
      },
      session,
    })
    await recordAudit({
      actorId: actor.id,
      action: 'farmer.merged_into',
      objectType: 'farmer',
      objectId: duplicate._id,
      after: { target: target._id },
      session,
    })
    return result
  })
}

/** An RA 10173 erasure request: blanks personal data and keeps anonymous history (ADR-0006). */
export async function eraseFarmerPersonalData({
  actor,
  farmerId,
}: {
  actor: Actor
  farmerId: string
}): Promise<FarmerDoc> {
  return inTransaction(async (session) => {
    const farmer = await farmerInScope(actor, farmerId, session)
    if (!farmer) throw notFound()
    requireReach(
      actor.scope,
      Cap.ADMIN,
      { barangayId: farmer.homeBarangayId, municipalityId: farmer.municipalityId },
      'farmer',
    )
    farmer.firstName = ''
    farmer.middleName = ''
    farmer.lastName = ''
    farmer.suffix = ''
    farmer.fullNameRaw = '[erased]'
    farmer.sex = ''
    farmer.contactNo = ''
    farmer.birthYear = null
    farmer.rsbsaNo = null
    farmer.status = 'inactive'
    farmer.updatedBy = actor.id
    await farmer.save({ session })
    await Farm.updateMany(
      { farmerId: farmer._id },
      { sitio: '', location: null, locationRaw: '', updatedBy: actor.id },
      { session },
    )
    await recordAudit({
      actorId: actor.id,
      action: 'farmer.erase',
      objectType: 'farmer',
      objectId: farmer._id,
      session,
    })
    return farmer.toObject()
  })
}

// --- Associations

type AssociationDocument = HydratedDocument<AssociationDoc>

function associationSnapshot(association: AssociationDoc): Record<string, unknown> {
  return {
    name: association.name,
    short_name: association.shortName,
    type: association.type,
    municipality: association.municipalityId,
    registration_body: association.registrationBody,
    registration_no: association.registrationNo,
  }
}

function assignAssociationValues(association: AssociationDocument, data: AssociationValues): void {
  if (data.name !== undefined) association.name = collapseSpaces(data.name)
  if (data.shortName !== undefined) association.shortName = data.shortName
  if (data.type !== undefined) association.type = data.type
  if (data.registrationBody !== undefined) association.registrationBody = data.registrationBody
  if (data.registrationNo !== undefined) association.registrationNo = data.registrationNo
}

async function saveAssociation(
  association: AssociationDocument,
  session: ClientSession,
): Promise<void> {
  try {
    await association.save({ session })
  } catch (error) {
    if (isDuplicateKey(error, 'normalizedName')) {
      throw new DomainError(
        'duplicate_association',
        'An association with this name already exists in the municipality.',
        { name: ['Already exists in this municipality.'] },
        409,
      )
    }
    throw error
  }
}

async function municipalityOr400(id: string, session: ClientSession): Promise<void> {
  if (!(await Municipality.exists({ _id: id }).session(session))) {
    throw invalidReference('municipality')
  }
}

async function associationInScope(
  actor: Actor,
  id: string,
  session: ClientSession,
): Promise<AssociationDocument> {
  const visible = scopeFilter(actor.scope, Cap.VIEW_RECORDS, ASSOCIATION_SCOPE)
  const association = await Association.findOne(within(visible, { _id: id })).session(session)
  if (!association) throw notFound()
  return association
}

function requireAssociationReach(actor: Actor, municipalityId: string, field: string): void {
  requireReach(actor.scope, Cap.EDIT_RECORDS, { municipalityId }, field)
}

export async function createAssociation({
  actor,
  data,
}: {
  actor: Actor
  data: AssociationValues
}): Promise<AssociationDoc> {
  return inTransaction(async (session) => {
    if (!collapseSpaces(data.name)) {
      throw new DomainError('name_required', 'Enter the association name.', { name: ['Required.'] })
    }
    if (data.municipality === undefined) throw invalidReference('municipality')
    await municipalityOr400(data.municipality, session)
    requireAssociationReach(actor, data.municipality, 'municipality')
    const association: AssociationDocument = new Association({
      municipalityId: data.municipality,
      createdBy: actor.id,
      updatedBy: actor.id,
    })
    assignAssociationValues(association, data)
    await saveAssociation(association, session)
    await recordAudit({
      actorId: actor.id,
      action: 'association.create',
      objectType: 'association',
      objectId: association._id,
      after: associationSnapshot(association),
      session,
    })
    return association.toObject()
  })
}

export async function updateAssociation({
  actor,
  associationId,
  data,
}: {
  actor: Actor
  associationId: string
  data: AssociationValues
}): Promise<AssociationDoc> {
  return inTransaction(async (session) => {
    const association = await associationInScope(actor, associationId, session)
    requireAssociationReach(actor, association.municipalityId, 'municipality')
    const before = associationSnapshot(association)
    assignAssociationValues(association, data)
    if (data.municipality !== undefined) {
      await municipalityOr400(data.municipality, session)
      requireAssociationReach(actor, data.municipality, 'municipality')
      association.municipalityId = data.municipality
    }
    association.updatedBy = actor.id
    await saveAssociation(association, session)
    const diff = changes(before, associationSnapshot(association))
    if (Object.keys(diff.after).length > 0) {
      await recordAudit({
        actorId: actor.id,
        action: 'association.update',
        objectType: 'association',
        objectId: association._id,
        before: diff.before,
        after: diff.after,
        session,
      })
    }
    return association.toObject()
  })
}

export async function deleteAssociation({
  actor,
  associationId,
}: {
  actor: Actor
  associationId: string
}): Promise<void> {
  await inTransaction(async (session) => {
    const association = await associationInScope(actor, associationId, session)
    requireAssociationReach(actor, association.municipalityId, 'municipality')
    if (await AssociationMember.exists({ associationId }).session(session)) {
      throw new DomainError(
        'has_members',
        'Remove the members before deleting the association.',
        {},
        409,
      )
    }
    markDeleted(association, actor.id)
    await association.save({ session })
    await recordAudit({
      actorId: actor.id,
      action: 'association.delete',
      objectType: 'association',
      objectId: association._id,
      session,
    })
  })
}

export async function addMember({
  actor,
  associationId,
  farmerId,
  role = '',
  since = null,
}: {
  actor: Actor
  associationId: string
  farmerId: string
  role?: string | undefined
  since?: string | null | undefined
}): Promise<string> {
  return inTransaction(async (session) => {
    const association = await associationInScope(actor, associationId, session)
    const farmer = await farmerInScope(actor, farmerId, session)
    if (!farmer) {
      throw new DomainError('not_found', 'Farmer not found.', { farmer: ['Not found.'] }, 404)
    }
    requireAssociationReach(actor, association.municipalityId, 'association')
    requireReach(
      actor.scope,
      Cap.EDIT_RECORDS,
      { barangayId: farmer.homeBarangayId, municipalityId: farmer.municipalityId },
      'farmer',
    )
    await lockForWrite(Farmer, farmerId, session)
    await lockForWrite(Association, associationId, session)
    const alreadyMember = () =>
      new DomainError(
        'already_member',
        'This farmer is already a member.',
        { farmer: ['Already a member.'] },
        409,
      )
    if (await AssociationMember.exists({ associationId, farmerId }).session(session)) {
      throw alreadyMember()
    }
    const member = new AssociationMember({
      associationId,
      farmerId,
      role: collapseSpaces(role),
      since: since ? parseDateOnly(since) : null,
      createdBy: actor.id,
      updatedBy: actor.id,
    })
    try {
      await member.save({ session })
    } catch (error) {
      if (isDuplicateKey(error, 'farmerId')) throw alreadyMember()
      throw error
    }
    await recordAudit({
      actorId: actor.id,
      action: 'association.add_member',
      objectType: 'association',
      objectId: associationId,
      after: { farmer: farmerId, role: member.role },
      session,
    })
    return member._id
  })
}

export async function removeMember({
  actor,
  associationId,
  memberId,
}: {
  actor: Actor
  associationId: string
  memberId: string
}): Promise<void> {
  await inTransaction(async (session) => {
    const association = await associationInScope(actor, associationId, session)
    const member = await AssociationMember.findOne({ _id: memberId, associationId }).session(
      session,
    )
    if (!member) throw notFound()
    requireAssociationReach(actor, association.municipalityId, 'association')
    markDeleted(member, actor.id)
    await member.save({ session })
    await recordAudit({
      actorId: actor.id,
      action: 'association.remove_member',
      objectType: 'association',
      objectId: associationId,
      before: { farmer: member.farmerId },
      session,
    })
  })
}
