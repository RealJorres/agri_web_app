import type { ClientSession, HydratedDocument } from 'mongoose'

import { dateOnly, parseDateOnly } from '../lib/dates.js'
import { decimalString, toDecimal128 } from '../lib/decimal.js'
import { notFound } from '../lib/errors.js'
import { Cap } from '../lib/roles.js'
import { requireReach, scopeFilter, within, type Actor } from '../lib/scoping.js'
import { inTransaction } from '../lib/transaction.js'
import { lockForWrite, markDeleted } from '../models/base.js'
import {
  COPIED_SCOPE,
  type CopiedScope,
  CropStand,
  type CropStandDoc,
  Harvest,
  type HarvestDoc,
} from '../models/farm.models.js'
import type { HarvestValues } from '../validators/farm.validators.js'
import { changes, mask, recordAudit } from './audit.service.js'

const PERSONAL = ['buyer']

function requireEdit(actor: Actor, target: CopiedScope): void {
  requireReach(
    actor.scope,
    Cap.EDIT_RECORDS,
    {
      barangayId: target.barangayId,
      municipalityId: target.municipalityId,
      programId: target.programId,
    },
    'crop_stand',
  )
}

function snapshot(harvest: HarvestDoc): Record<string, unknown> {
  return {
    harvest_date: dateOnly(harvest.harvestDate),
    date_estimated: harvest.dateEstimated,
    quantity: decimalString(harvest.quantity, 3),
    unit: harvest.unit,
    product_form: harvest.productForm,
    price_per_unit: decimalString(harvest.pricePerUnit, 2),
    buyer: harvest.buyer,
    raw_text: harvest.rawText,
  }
}

function assign(harvest: HydratedDocument<HarvestDoc>, data: HarvestValues): void {
  if (data.harvestDate !== undefined) {
    harvest.harvestDate = data.harvestDate === null ? null : parseDateOnly(data.harvestDate)
  }
  if (data.dateEstimated !== undefined) harvest.dateEstimated = data.dateEstimated
  if (data.quantity !== undefined) harvest.quantity = toDecimal128(data.quantity)
  if (data.unit !== undefined) harvest.unit = data.unit
  if (data.productForm !== undefined) harvest.productForm = data.productForm
  if (data.pricePerUnit !== undefined) {
    harvest.pricePerUnit = data.pricePerUnit === null ? null : toDecimal128(data.pricePerUnit)
  }
  if (data.buyer !== undefined) harvest.buyer = data.buyer
  if (data.rawText !== undefined) harvest.rawText = data.rawText
}

export async function createHarvest({
  actor,
  standId,
  data,
}: {
  actor: Actor
  standId: string
  data: HarvestValues
}): Promise<HarvestDoc> {
  return inTransaction(async (session) => {
    const visible = scopeFilter(actor.scope, Cap.VIEW_RECORDS, COPIED_SCOPE)
    const stand = await CropStand.findOne(within(visible, { _id: standId }))
      .session(session)
      .lean<CropStandDoc>()
    if (!stand) throw notFound()
    requireEdit(actor, stand)
    if (!(await lockForWrite(CropStand, standId, session))) throw notFound()
    const harvest: HydratedDocument<HarvestDoc> = new Harvest({
      cropStandId: standId,
      barangayId: stand.barangayId,
      municipalityId: stand.municipalityId,
      programId: stand.programId,
      createdBy: actor.id,
      updatedBy: actor.id,
    })
    assign(harvest, data)
    if (harvest.harvestDate === null) harvest.dateEstimated = true
    await harvest.save({ session })
    await recordAudit({
      actorId: actor.id,
      action: 'harvest.create',
      objectType: 'harvest',
      objectId: harvest._id,
      after: mask(snapshot(harvest), PERSONAL),
      session,
    })
    return harvest.toObject()
  })
}

async function harvestInScope(
  actor: Actor,
  id: string,
  session: ClientSession,
): Promise<HydratedDocument<HarvestDoc>> {
  const visible = scopeFilter(actor.scope, Cap.VIEW_RECORDS, COPIED_SCOPE)
  const harvest = await Harvest.findOne(within(visible, { _id: id })).session(session)
  if (!harvest) throw notFound()
  return harvest
}

export async function updateHarvest({
  actor,
  harvestId,
  data,
}: {
  actor: Actor
  harvestId: string
  data: HarvestValues
}): Promise<HarvestDoc> {
  return inTransaction(async (session) => {
    const harvest = await harvestInScope(actor, harvestId, session)
    requireEdit(actor, harvest)
    const before = snapshot(harvest)
    assign(harvest, data)
    harvest.updatedBy = actor.id
    await harvest.save({ session })
    const diff = changes(before, snapshot(harvest), PERSONAL)
    if (Object.keys(diff.after).length > 0) {
      await recordAudit({
        actorId: actor.id,
        action: 'harvest.update',
        objectType: 'harvest',
        objectId: harvest._id,
        before: diff.before,
        after: diff.after,
        session,
      })
    }
    return harvest.toObject()
  })
}

export async function deleteHarvest({
  actor,
  harvestId,
}: {
  actor: Actor
  harvestId: string
}): Promise<void> {
  await inTransaction(async (session) => {
    const harvest = await harvestInScope(actor, harvestId, session)
    requireEdit(actor, harvest)
    markDeleted(harvest, actor.id)
    await harvest.save({ session })
    await recordAudit({
      actorId: actor.id,
      action: 'harvest.delete',
      objectType: 'harvest',
      objectId: harvest._id,
      session,
    })
  })
}
