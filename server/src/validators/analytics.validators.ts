import { z } from 'zod'

import { filterId, id, integer } from './common.js'

export const municipalityQuery = z.object({ municipality: filterId })

const level = z.preprocess(
  (value) => (value === '' || value === undefined ? 'municipality' : value),
  z.enum(['municipality', 'barangay']),
)

export const levelQuery = z.object({ level, municipality: filterId })

export const trendsQuery = z.object({ commodity: id, municipality: filterId })

export const harvestQuery = z.object({
  commodity: filterId,
  year: z.preprocess((value) => (value === '' ? undefined : value), integer(1900, 2200).optional()),
})
