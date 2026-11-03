import { z } from 'zod'

const id = z.guid('Must be a valid UUID.').optional()

export const barangayQuery = z.object({
  municipality: id,
  // Anything other than true or false means no filter, as it did before.
  is_verified: z
    .unknown()
    .transform((value) => {
      const text = typeof value === 'string' ? value.toLowerCase() : ''
      if (text === 'true') return true
      if (text === 'false') return false
      return undefined
    })
    .optional(),
  q: z.string().optional(),
})

export const commodityQuery = z.object({ program: id })

export const varietyQuery = z.object({ commodity: id })
