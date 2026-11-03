import { z } from 'zod'

import { IMPORT_KINDS } from '../models/import.models.js'
import { id, isoDate, text } from './common.js'

// A form field left empty means no value.
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (value === '' || value === 'null' ? null : value),
    schema.nullable().optional(),
  )

export const uploadBody = z.object({
  kind: z.enum(IMPORT_KINDS),
  survey_round: optional(id),
  commodity: optional(id),
  round_name: optional(text(150)),
  as_of_date: optional(isoDate),
})

export const commitBody = z.preprocess(
  (value) => value ?? {},
  z.object({ association_overrides: z.record(z.string(), z.string()).optional() }),
)

export const templateQuery = z.object({ commodity: id })
