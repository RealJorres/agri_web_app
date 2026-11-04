/**
 * One row of data entered by hand: the same thing as one row of the import template. Everything it
 * needs is created in one transaction, so a refused record leaves no farmer or farm behind.
 */
import { DomainError, notFound } from '../lib/errors.js'
import { Cap } from '../lib/roles.js'
import { requireReach, scopeFilter, within, type Actor } from '../lib/scoping.js'
import { inTransaction } from '../lib/transaction.js'
import { CropStand, Farm, type FarmDoc } from '../models/farm.models.js'
import { Farmer, FARMER_SCOPE, type FarmerDoc } from '../models/registry.models.js'
import {
  SurveyRound,
  type InventoryRecordDoc,
  type SurveyRoundDoc,
} from '../models/survey.models.js'
import type { PlantingValues } from '../validators/farm.validators.js'
import type { FarmerValues } from '../validators/registry.validators.js'
import { createCropStand, createFarm, createPlanting } from './farm.service.js'
import { createFarmer } from './registry.service.js'
import { createRecord } from './survey.service.js'

type RecordInput = Parameters<typeof createRecord>[0]

export interface EntryInput {
  actor: Actor
  roundId: string
  /** An existing farmer, or the details of a new one. Exactly one of the two. */
  farmerId?: string | undefined
  newFarmer?: { data: FarmerValues; consentGiven: boolean } | undefined
  /** Where the farm is. Defaults to the farmer's home barangay. */
  barangayId?: string | undefined
  sitio?: string | undefined
  planting?: { data: PlantingValues; varietyIds?: readonly string[] | undefined } | undefined
  counts?: RecordInput['counts']
  remarks?: string | undefined
}

/** A farmer's farm in this place, if there is one. Without a sitio, any in the barangay will do. */
function matchingFarm(farms: FarmDoc[], sitio: string): FarmDoc | undefined {
  const wanted = sitio.trim().toLowerCase()
  return farms.find((farm) => !wanted || farm.sitio.trim().toLowerCase() === wanted)
}

function hasPlantingDetails({ data, varietyIds }: NonNullable<EntryInput['planting']>): boolean {
  return (
    Boolean(data.yearPlanted ?? data.source ?? data.qtyPlanted ?? data.notes) ||
    !!varietyIds?.length
  )
}

export async function createEntry({
  actor,
  roundId,
  farmerId,
  newFarmer,
  barangayId,
  sitio = '',
  planting,
  counts,
  remarks,
}: EntryInput): Promise<InventoryRecordDoc> {
  return inTransaction(async (session) => {
    const round = await SurveyRound.findOne({ _id: roundId })
      .session(session)
      .lean<SurveyRoundDoc>()
    if (!round) {
      throw new DomainError('validation_error', 'Some fields are invalid.', {
        survey_round: ['This does not exist.'],
      })
    }

    let farmer: FarmerDoc
    if (newFarmer) {
      farmer = await createFarmer({ actor, ...newFarmer })
    } else {
      const visible = scopeFilter(actor.scope, Cap.VIEW_RECORDS, FARMER_SCOPE)
      const found = await Farmer.findOne(within(visible, { _id: farmerId }))
        .session(session)
        .lean<FarmerDoc>()
      if (!found) throw notFound()
      requireReach(
        actor.scope,
        Cap.EDIT_RECORDS,
        { barangayId: found.homeBarangayId, municipalityId: found.municipalityId },
        'farmer',
      )
      farmer = found
    }

    const barangay = barangayId ?? farmer.homeBarangayId
    const farms = await Farm.find({ farmerId: farmer._id, barangayId: barangay })
      .sort({ _id: 1 })
      .session(session)
      .lean<FarmDoc[]>()
    const farm =
      matchingFarm(farms, sitio) ??
      (await createFarm({
        actor,
        farmerId: farmer._id,
        data: { barangay, sitio },
      }))

    const stand =
      (await CropStand.findOne({ farmId: farm._id, commodityId: round.commodityId })
        .session(session)
        .lean()) ??
      (await createCropStand({
        actor,
        farmId: farm._id,
        commodityId: round.commodityId,
        data: {},
      }))

    if (planting && hasPlantingDetails(planting)) {
      await createPlanting({ actor, standId: stand._id, ...planting })
    }

    return createRecord({ actor, roundId, standId: stand._id, counts, remarks })
  })
}
