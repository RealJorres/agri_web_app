/**
 * Farm, crop stand and planting writes. Scope is checked on the farm's barangay and, for crop stands,
 * on the commodity's program. These services own the location and program keys copied onto everything
 * under a farm, and keep them correct when a farm moves (ADR-0019).
 */
import type { ClientSession, HydratedDocument } from 'mongoose'

import { decimalString, toDecimal128 } from '../lib/decimal.js'
import { DomainError, notFound } from '../lib/errors.js'
import { isDuplicateKey } from '../lib/mongoErrors.js'
import { Cap } from '../lib/roles.js'
import { requireReach, scopeFilter, within, type Actor } from '../lib/scoping.js'
import { collapseSpaces } from '../lib/text.js'
import { inTransaction } from '../lib/transaction.js'
import { lockForWrite, markDeleted } from '../models/base.js'
import {
  Commodity,
  MaterialSource,
  Variety,
  type CommodityDoc,
  type VarietyDoc,
} from '../models/catalog.models.js'
import {
  COPIED_SCOPE,
  CropStand,
  type CropStandDoc,
  Farm,
  FARM_PERSONAL_FIELDS,
  FARM_SCOPE,
  type FarmDoc,
  Harvest,
  Planting,
  type PlantingDoc,
} from '../models/farm.models.js'
import { Barangay, type BarangayDoc } from '../models/location.models.js'
import { Farmer, FARMER_SCOPE, type FarmerDoc } from '../models/registry.models.js'
import { InventoryRecord } from '../models/survey.models.js'
import type { FarmValues, PlantingValues, StandValues } from '../validators/farm.validators.js'
import { changes, mask, recordAudit } from './audit.service.js'
import { validateAttributes } from './catalog.service.js'

function invalidReference(field: string): DomainError {
  return new DomainError('validation_error', 'Some fields are invalid.', {
    [field]: ['This does not exist.'],
  })
}

type Scoped = Pick<FarmDoc, 'barangayId' | 'municipalityId'> & { programId?: string | null }

function requireEdit(actor: Actor, target: Scoped, field = 'barangay'): void {
  requireReach(
    actor.scope,
    Cap.EDIT_RECORDS,
    {
      barangayId: target.barangayId,
      municipalityId: target.municipalityId,
      programId: target.programId ?? null,
    },
    field,
  )
}

// --- Farms

function farmSnapshot(farm: FarmDoc): Record<string, unknown> {
  return {
    barangay: farm.barangayId,
    sitio: farm.sitio,
    location: farm.location ? [...farm.location.coordinates] : null,
    declared_area_ha: decimalString(farm.declaredAreaHa, 4),
    tenure: farm.tenure,
    location_raw: farm.locationRaw,
  }
}

function assignFarmValues(farm: HydratedDocument<FarmDoc>, data: FarmValues): void {
  if (data.sitio !== undefined) farm.sitio = collapseSpaces(data.sitio)
  if (data.location !== undefined) {
    farm.set(
      'location',
      data.location && { type: 'Point', coordinates: [data.location.lon, data.location.lat] },
    )
  }
  if (data.declaredAreaHa !== undefined) {
    farm.declaredAreaHa = data.declaredAreaHa === null ? null : toDecimal128(data.declaredAreaHa)
  }
  if (data.tenure !== undefined) farm.tenure = data.tenure
  if (data.locationRaw !== undefined) farm.locationRaw = data.locationRaw
}

async function barangayOr400(id: string, session: ClientSession): Promise<BarangayDoc> {
  const barangay = await Barangay.findOne({ _id: id }).session(session).lean<BarangayDoc>()
  if (!barangay) throw invalidReference('barangay')
  return barangay
}

async function farmInScope(
  actor: Actor,
  id: string,
  session: ClientSession,
): Promise<HydratedDocument<FarmDoc>> {
  const visible = scopeFilter(actor.scope, Cap.VIEW_RECORDS, FARM_SCOPE)
  const farm = await Farm.findOne(within(visible, { _id: id })).session(session)
  if (!farm) throw notFound()
  return farm
}

export async function createFarm({
  actor,
  farmerId,
  data,
}: {
  actor: Actor
  farmerId: string
  data: FarmValues
}): Promise<FarmDoc> {
  return inTransaction(async (session) => {
    const visible = scopeFilter(actor.scope, Cap.VIEW_RECORDS, FARMER_SCOPE)
    const farmer = await Farmer.findOne(within(visible, { _id: farmerId }))
      .session(session)
      .lean<FarmerDoc>()
    if (!farmer) {
      throw new DomainError('not_found', 'Farmer not found.', { farmer: ['Not found.'] }, 404)
    }
    requireReach(
      actor.scope,
      Cap.EDIT_RECORDS,
      { barangayId: farmer.homeBarangayId, municipalityId: farmer.municipalityId },
      'farmer',
    )
    if (data.barangay === undefined) {
      throw new DomainError('barangay_required', "Choose the farm's barangay.", {
        barangay: ['Required.'],
      })
    }
    const barangay = await barangayOr400(data.barangay, session)
    requireEdit(actor, { barangayId: barangay._id, municipalityId: barangay.municipalityId })
    if (!(await lockForWrite(Farmer, farmerId, session))) throw notFound()
    const farm: HydratedDocument<FarmDoc> = new Farm({
      farmerId,
      barangayId: barangay._id,
      municipalityId: barangay.municipalityId,
      createdBy: actor.id,
      updatedBy: actor.id,
    })
    assignFarmValues(farm, data)
    await farm.save({ session })
    await recordAudit({
      actorId: actor.id,
      action: 'farm.create',
      objectType: 'farm',
      objectId: farm._id,
      after: mask({ farmer: farmerId, ...farmSnapshot(farm) }, FARM_PERSONAL_FIELDS),
      session,
    })
    return farm.toObject()
  })
}

// Soft-deleted rows move too, so a row's keys never disagree with its farm's history.
const INCLUDING_DELETED = { isDeleted: { $in: [true, false] } }

/**
 * Copies a farm's new location onto its crop stands, plantings, harvests and inventory records.
 */
async function moveFarmKeys(farm: FarmDoc, actor: Actor, session: ClientSession): Promise<void> {
  const keys = {
    barangayId: farm.barangayId,
    municipalityId: farm.municipalityId,
    updatedBy: actor.id,
  }
  const stands = await CropStand.find({ farmId: farm._id, ...INCLUDING_DELETED })
    .session(session)
    .select('_id')
    .lean()
  const cropStandId = { $in: stands.map((stand) => stand._id) }
  await CropStand.updateMany({ farmId: farm._id, ...INCLUDING_DELETED }, keys, { session })
  await Planting.updateMany({ cropStandId, ...INCLUDING_DELETED }, keys, { session })
  await Harvest.updateMany({ cropStandId, ...INCLUDING_DELETED }, keys, { session })
  await InventoryRecord.updateMany({ cropStandId, ...INCLUDING_DELETED }, keys, { session })
}

export async function updateFarm({
  actor,
  farmId,
  data,
  farmerId,
}: {
  actor: Actor
  farmId: string
  data: FarmValues
  /** When sent, must match the current owner. Ownership only changes through a merge. */
  farmerId?: string | undefined
}): Promise<FarmDoc> {
  return inTransaction(async (session) => {
    const farm = await farmInScope(actor, farmId, session)
    if (farmerId !== undefined && farmerId !== farm.farmerId) {
      throw new DomainError(
        'farmer_immutable',
        'A farm cannot change owner here; merge the farmers instead.',
        { farmer: ['Cannot be changed.'] },
      )
    }
    requireEdit(actor, farm)
    const before = farmSnapshot(farm)
    assignFarmValues(farm, data)
    if (data.barangay !== undefined && data.barangay !== farm.barangayId) {
      const barangay = await barangayOr400(data.barangay, session)
      requireEdit(actor, { barangayId: barangay._id, municipalityId: barangay.municipalityId })
      farm.barangayId = barangay._id
      farm.municipalityId = barangay.municipalityId
      await moveFarmKeys(farm, actor, session)
    }
    farm.updatedBy = actor.id
    await farm.save({ session })
    const diff = changes(before, farmSnapshot(farm), FARM_PERSONAL_FIELDS)
    if (Object.keys(diff.after).length > 0) {
      await recordAudit({
        actorId: actor.id,
        action: 'farm.update',
        objectType: 'farm',
        objectId: farm._id,
        before: diff.before,
        after: diff.after,
        session,
      })
    }
    return farm.toObject()
  })
}

export async function deleteFarm({
  actor,
  farmId,
}: {
  actor: Actor
  farmId: string
}): Promise<void> {
  await inTransaction(async (session) => {
    const farm = await farmInScope(actor, farmId, session)
    requireEdit(actor, farm)
    if (await CropStand.exists({ farmId }).session(session)) {
      throw new DomainError('has_crop_stands', "Delete the farm's crop stands first.", {}, 409)
    }
    markDeleted(farm, actor.id)
    await farm.save({ session })
    await recordAudit({
      actorId: actor.id,
      action: 'farm.delete',
      objectType: 'farm',
      objectId: farm._id,
      session,
    })
  })
}

// --- Crop stands

function standSnapshot(stand: CropStandDoc): Record<string, unknown> {
  return { spacing_m: decimalString(stand.spacingM, 2), attributes: stand.attributes }
}

async function standInScope(
  actor: Actor,
  id: string,
  session: ClientSession,
): Promise<HydratedDocument<CropStandDoc>> {
  const visible = scopeFilter(actor.scope, Cap.VIEW_RECORDS, COPIED_SCOPE)
  const stand = await CropStand.findOne(within(visible, { _id: id })).session(session)
  if (!stand) throw notFound()
  return stand
}

export async function createCropStand({
  actor,
  farmId,
  commodityId,
  data,
}: {
  actor: Actor
  farmId: string
  commodityId: string
  data: StandValues
}): Promise<CropStandDoc> {
  return inTransaction(async (session) => {
    const farm = await farmInScope(actor, farmId, session)
    const commodity = await Commodity.findOne({ _id: commodityId })
      .session(session)
      .lean<CommodityDoc>()
    if (!commodity) throw invalidReference('commodity')
    requireEdit(actor, { ...farm.toObject(), programId: commodity.programId })
    const attributes = data.attributes ?? {}
    validateAttributes(commodity, attributes)
    if (!(await lockForWrite(Farm, farmId, session))) throw notFound()
    const stand: HydratedDocument<CropStandDoc> = new CropStand({
      farmId,
      commodityId,
      barangayId: farm.barangayId,
      municipalityId: farm.municipalityId,
      programId: commodity.programId,
      spacingM: data.spacingM ? toDecimal128(data.spacingM) : null,
      attributes,
      createdBy: actor.id,
      updatedBy: actor.id,
    })
    try {
      await stand.save({ session })
    } catch (error) {
      if (isDuplicateKey(error, 'commodityId')) {
        throw new DomainError(
          'duplicate_crop_stand',
          `This farm already has a ${commodity.name} crop stand.`,
          { commodity: ['Already recorded on this farm.'] },
          409,
        )
      }
      throw error
    }
    await recordAudit({
      actorId: actor.id,
      action: 'crop_stand.create',
      objectType: 'crop_stand',
      objectId: stand._id,
      after: { farm: farmId, commodity: commodity.code, ...standSnapshot(stand) },
      session,
    })
    return stand.toObject()
  })
}

export async function updateCropStand({
  actor,
  standId,
  data,
}: {
  actor: Actor
  standId: string
  data: StandValues
}): Promise<CropStandDoc> {
  return inTransaction(async (session) => {
    const stand = await standInScope(actor, standId, session)
    requireEdit(actor, stand)
    const before = standSnapshot(stand)
    if (data.attributes !== undefined) {
      const commodity = await Commodity.findOne({ _id: stand.commodityId })
        .session(session)
        .lean<CommodityDoc>()
      if (!commodity) throw notFound()
      validateAttributes(commodity, data.attributes)
      stand.attributes = data.attributes
      stand.markModified('attributes')
    }
    if (data.spacingM !== undefined) {
      stand.spacingM = data.spacingM === null ? null : toDecimal128(data.spacingM)
    }
    stand.updatedBy = actor.id
    await stand.save({ session })
    const diff = changes(before, standSnapshot(stand))
    if (Object.keys(diff.after).length > 0) {
      await recordAudit({
        actorId: actor.id,
        action: 'crop_stand.update',
        objectType: 'crop_stand',
        objectId: stand._id,
        before: diff.before,
        after: diff.after,
        session,
      })
    }
    return stand.toObject()
  })
}

export async function deleteCropStand({
  actor,
  standId,
}: {
  actor: Actor
  standId: string
}): Promise<void> {
  await inTransaction(async (session) => {
    const stand = await standInScope(actor, standId, session)
    requireEdit(actor, stand)
    if (await Planting.exists({ cropStandId: standId }).session(session)) {
      throw new DomainError('has_plantings', 'Delete the plantings first.', {}, 409)
    }
    if (await InventoryRecord.exists({ cropStandId: standId }).session(session)) {
      throw new DomainError(
        'has_inventory',
        'This crop stand has inventory records and cannot be deleted.',
        {},
        409,
      )
    }
    markDeleted(stand, actor.id)
    await stand.save({ session })
    await recordAudit({
      actorId: actor.id,
      action: 'crop_stand.delete',
      objectType: 'crop_stand',
      objectId: stand._id,
      session,
    })
  })
}

// --- Plantings

async function chosenVarieties(
  stand: Pick<CropStandDoc, 'commodityId'>,
  ids: readonly string[],
  session: ClientSession,
): Promise<VarietyDoc[]> {
  const unique = [...new Set(ids)]
  const rows = await Variety.find({ _id: { $in: unique } })
    .session(session)
    .lean<VarietyDoc[]>()
  if (rows.length !== unique.length) throw invalidReference('varieties')
  const wrong = rows.filter((row) => row.commodityId !== stand.commodityId).map((row) => row.code)
  if (wrong.length > 0) {
    const commodity = await Commodity.findOne({ _id: stand.commodityId })
      .session(session)
      .lean<CommodityDoc>()
    const name = commodity?.name ?? 'this crop'
    throw new DomainError('variety_mismatch', `Varieties must be ${name} varieties.`, {
      varieties: [`Not a ${name} variety: ${wrong.join(', ')}`],
    })
  }
  return rows
}

async function plantingSnapshot(
  planting: PlantingDoc,
  session: ClientSession,
): Promise<Record<string, unknown>> {
  const varieties = await Variety.find({ _id: { $in: planting.varietyIds } })
    .session(session)
    .lean<VarietyDoc[]>()
  return {
    year_planted: planting.yearPlanted,
    source: planting.sourceId,
    qty_planted: planting.qtyPlanted,
    notes: planting.notes,
    varieties: varieties.map((variety) => variety.code).sort(),
  }
}

async function assignPlantingValues(
  planting: HydratedDocument<PlantingDoc>,
  data: PlantingValues,
  session: ClientSession,
): Promise<void> {
  if (data.yearPlanted !== undefined) planting.yearPlanted = data.yearPlanted
  if (data.qtyPlanted !== undefined) planting.qtyPlanted = data.qtyPlanted
  if (data.notes !== undefined) planting.notes = data.notes
  if (data.source !== undefined) {
    if (
      data.source !== null &&
      !(await MaterialSource.exists({ _id: data.source }).session(session))
    ) {
      throw invalidReference('source')
    }
    planting.sourceId = data.source
  }
}

export async function createPlanting({
  actor,
  standId,
  data,
  varietyIds = [],
}: {
  actor: Actor
  standId: string
  data: PlantingValues
  varietyIds?: readonly string[] | undefined
}): Promise<PlantingDoc> {
  return inTransaction(async (session) => {
    const stand = await standInScope(actor, standId, session)
    requireEdit(actor, stand)
    const varieties = await chosenVarieties(stand, varietyIds, session)
    if (!(await lockForWrite(CropStand, standId, session))) throw notFound()
    const planting: HydratedDocument<PlantingDoc> = new Planting({
      cropStandId: standId,
      barangayId: stand.barangayId,
      municipalityId: stand.municipalityId,
      programId: stand.programId,
      varietyIds: varieties.map((variety) => variety._id),
      createdBy: actor.id,
      updatedBy: actor.id,
    })
    await assignPlantingValues(planting, data, session)
    await planting.save({ session })
    await recordAudit({
      actorId: actor.id,
      action: 'planting.create',
      objectType: 'planting',
      objectId: planting._id,
      after: await plantingSnapshot(planting, session),
      session,
    })
    return planting.toObject()
  })
}

async function plantingInScope(
  actor: Actor,
  id: string,
  session: ClientSession,
): Promise<HydratedDocument<PlantingDoc>> {
  const visible = scopeFilter(actor.scope, Cap.VIEW_RECORDS, COPIED_SCOPE)
  const planting = await Planting.findOne(within(visible, { _id: id })).session(session)
  if (!planting) throw notFound()
  return planting
}

export async function updatePlanting({
  actor,
  plantingId,
  data,
  varietyIds,
}: {
  actor: Actor
  plantingId: string
  data: PlantingValues
  varietyIds?: readonly string[] | undefined
}): Promise<PlantingDoc> {
  return inTransaction(async (session) => {
    const planting = await plantingInScope(actor, plantingId, session)
    requireEdit(actor, planting)
    const before = await plantingSnapshot(planting, session)
    await assignPlantingValues(planting, data, session)
    if (varietyIds !== undefined) {
      const stand = await CropStand.findOne({ _id: planting.cropStandId })
        .session(session)
        .lean<CropStandDoc>()
      if (!stand) throw notFound()
      const varieties = await chosenVarieties(stand, varietyIds, session)
      planting.varietyIds = varieties.map((variety) => variety._id)
    }
    planting.updatedBy = actor.id
    await planting.save({ session })
    const diff = changes(before, await plantingSnapshot(planting, session))
    if (Object.keys(diff.after).length > 0) {
      await recordAudit({
        actorId: actor.id,
        action: 'planting.update',
        objectType: 'planting',
        objectId: planting._id,
        before: diff.before,
        after: diff.after,
        session,
      })
    }
    return planting.toObject()
  })
}

export async function deletePlanting({
  actor,
  plantingId,
}: {
  actor: Actor
  plantingId: string
}): Promise<void> {
  await inTransaction(async (session) => {
    const planting = await plantingInScope(actor, plantingId, session)
    requireEdit(actor, planting)
    markDeleted(planting, actor.id)
    await planting.save({ session })
    await recordAudit({
      actorId: actor.id,
      action: 'planting.delete',
      objectType: 'planting',
      objectId: planting._id,
      session,
    })
  })
}
