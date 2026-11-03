import { z } from 'zod'

import { HARVEST_UNITS, PRODUCT_FORMS, TENURES } from '../models/farm.models.js'
import {
  decimal,
  filterChoice,
  filterId,
  id,
  integer,
  isoDate,
  text,
  type CamelKeys,
} from './common.js'

const MAX_POSITIVE_INTEGER = 2_147_483_647

export const farmQuery = z.object({
  farmer: filterId,
  barangay: filterId,
  municipality: filterId,
  tenure: filterChoice(['', ...TENURES]),
})

export const pointsQuery = z.object({ municipality: filterId })

/** { lon, lat } in WGS84, limited to the Philippines' bounding box. */
const lonLat = z
  .object({ lon: z.coerce.number(), lat: z.coerce.number() })
  .refine(({ lon, lat }) => lon >= 116 && lon <= 127 && lat >= 4 && lat <= 22, {
    message: 'Location must be within the Philippines.',
  })

const farmFields = {
  sitio: text(100).optional(),
  location: lonLat.nullable().optional(),
  declared_area_ha: decimal({ maxDigits: 9, places: 4 }).nullable().optional(),
  tenure: z.enum(['', ...TENURES]).optional(),
  location_raw: text().optional(),
}

export const farmCreate = z.object({ farmer: id.optional(), barangay: id, ...farmFields })
export const farmUpdate = z.object({ farmer: id.optional(), barangay: id, ...farmFields })
export const farmPatch = farmUpdate.partial()

export type FarmValues = CamelKeys<Omit<z.infer<typeof farmPatch>, 'farmer'>>

const standFields = {
  spacing_m: decimal({ maxDigits: 5, places: 2 }).nullable().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
}

export const standCreate = z.object({ commodity: id, ...standFields })
export const standUpdate = z.object(standFields)

export type StandValues = CamelKeys<z.infer<typeof standUpdate>>

export const plantingWrite = z.object({
  year_planted: integer(1900, 2100).nullable().optional(),
  source: id.nullable().optional(),
  qty_planted: integer(0, MAX_POSITIVE_INTEGER).nullable().optional(),
  notes: text().optional(),
  varieties: z.array(id).optional(),
})

export type PlantingValues = CamelKeys<Omit<z.infer<typeof plantingWrite>, 'varieties'>>

const harvestOptional = {
  harvest_date: isoDate.nullable().optional(),
  date_estimated: z.boolean().optional(),
  product_form: z.enum(PRODUCT_FORMS).optional(),
  price_per_unit: decimal({ maxDigits: 12, places: 2 }).nullable().optional(),
  buyer: text(150).optional(),
  raw_text: text().optional(),
}

export const harvestWrite = z.object({
  quantity: decimal({ maxDigits: 12, places: 3 }),
  unit: z.enum(HARVEST_UNITS),
  ...harvestOptional,
})
export const harvestPatch = harvestWrite.partial()

export type HarvestValues = CamelKeys<z.infer<typeof harvestPatch>>
