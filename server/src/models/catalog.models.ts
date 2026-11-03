import { model, Schema } from 'mongoose'

import { baseFields, baseOptions, softDelete, uniqueAmongAlive, type BaseDoc } from './base.js'

export interface ProgramDoc extends BaseDoc {
  code: string
  name: string
}

const programSchema = new Schema<ProgramDoc>(
  {
    ...baseFields,
    code: { type: String, required: true },
    name: { type: String, required: true },
  },
  { ...baseOptions, collection: 'programs' },
)
programSchema.plugin(softDelete)
programSchema.index({ code: 1 }, uniqueAmongAlive)

export const Program = model<ProgramDoc>('Program', programSchema)
