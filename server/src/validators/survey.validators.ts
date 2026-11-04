import { z } from 'zod'

import { RECORD_STATUSES, ROUND_STATUSES } from '../models/survey.models.js'
import { decimal, filterChoice, filterId, id, integer, isoDate, text } from './common.js'
import { plantingWrite } from './farm.validators.js'
import { farmerWrite } from './registry.validators.js'

const MAX_POSITIVE_INTEGER = 2_147_483_647

export const roundQuery = z.object({
  commodity: filterId,
  status: filterChoice(ROUND_STATUSES),
})

export const roundCreate = z.object({
  commodity: id,
  name: text(150).min(1, 'This field may not be blank.'),
  as_of_date: isoDate,
  deadline: isoDate.nullable().optional(),
})

export const recordQuery = z.object({
  survey_round: filterId,
  crop_stand: filterId,
  farmer: filterId,
  municipality: filterId,
  barangay: filterId,
  // May repeat: ?status=submitted&status=validated.
  status: z.preprocess(
    (value) =>
      (Array.isArray(value) ? (value as unknown[]) : [value]).filter(
        (item) => item !== undefined && item !== '',
      ),
    z.array(z.enum(RECORD_STATUSES)),
  ),
})

const stageCount = z
  .object({
    growth_stage: id,
    count: integer(0, MAX_POSITIVE_INTEGER).nullable().optional(),
    area_ha: decimal({ maxDigits: 10, places: 4 }).nullable().optional(),
  })
  .transform(({ growth_stage: growthStageId, count, area_ha: areaHa }) => ({
    growthStageId,
    count,
    areaHa,
  }))

const recordFields = {
  counts: z.array(stageCount).optional(),
  remarks: text(2000).optional(),
}

export const recordCreate = z.object({ survey_round: id, crop_stand: id, ...recordFields })
export const recordUpdate = z.object(recordFields)

/** One row entered by hand: an existing farmer or a new one, with the farm, planting and counts. */
export const entryCreate = z
  .object({
    survey_round: id,
    farmer: id.optional(),
    new_farmer: farmerWrite.optional(),
    barangay: id.optional(),
    sitio: text(100).optional(),
    planting: plantingWrite.optional(),
    ...recordFields,
  })
  .refine(
    ({ farmer, new_farmer: newFarmer }) => (farmer === undefined) !== (newFarmer === undefined),
    {
      path: ['farmer'],
      message: 'Choose a farmer or enter a new one.',
    },
  )

// A body is optional on workflow actions, because a comment is only sometimes needed.
export const transitionBody = z.preprocess(
  (value) => value ?? {},
  z.object({ comment: text(2000).optional() }),
)
