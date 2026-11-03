import { z } from 'zod'

import { ASSOCIATION_TYPES, FARMER_STATUSES, SEXES } from '../models/registry.models.js'
import { filterChoice, filterId, id, integer, isoDate, text, type CamelKeys } from './common.js'

export const farmerQuery = z.object({
  q: z.string().optional(),
  municipality: filterId,
  barangay: filterId,
  association: filterId,
  status: filterChoice(FARMER_STATUSES),
})

export const farmerWrite = z.object({
  first_name: text(100).optional(),
  middle_name: text(100).optional(),
  last_name: text(100).optional(),
  suffix: text(20).optional(),
  sex: z.enum(['', ...SEXES]).optional(),
  birth_year: integer(1900, 2100).nullable().optional(),
  rsbsa_no: text(40).nullable().optional(),
  contact_no: text(40).optional(),
  home_barangay: id,
  status: z.enum(FARMER_STATUSES).optional(),
  consent_given: z.boolean().optional(),
})
export const farmerPatch = farmerWrite.partial()

export type FarmerValues = CamelKeys<Omit<z.infer<typeof farmerPatch>, 'consent_given'>> & {
  /** Set only by imports, from the name exactly as the source wrote it. */
  fullNameRaw?: string | undefined
}

export const duplicatesQuery = z.object({
  name: z.string().optional(),
  barangay: z.string().optional(),
  rsbsa_no: z.string().optional(),
  exclude: z.string().optional(),
})

export const mergeBody = z.object({ duplicate: id })

export const associationQuery = z.object({
  municipality: filterId,
  q: z.string().optional(),
  type: filterChoice(ASSOCIATION_TYPES),
})

export const associationWrite = z.object({
  name: text(200).min(1, 'This field may not be blank.'),
  short_name: text(50).optional(),
  type: z.enum(ASSOCIATION_TYPES).optional(),
  municipality: id,
  registration_body: text(100).optional(),
  registration_no: text(60).optional(),
})
export const associationPatch = associationWrite.partial()

export type AssociationValues = CamelKeys<z.infer<typeof associationPatch>>

export const memberBody = z.object({
  farmer: id,
  role: text(60).optional(),
  since: isoDate.nullable().optional(),
})
