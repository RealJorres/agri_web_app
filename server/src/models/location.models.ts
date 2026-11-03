import { model, Schema } from 'mongoose'

import { normalizeName } from '../lib/text.js'
import { baseFields, baseOptions, softDelete, uniqueAmongAlive, type BaseDoc } from './base.js'

export interface MunicipalityDoc extends BaseDoc {
  /** Empty until the official PSGC file is loaded; codes are never invented (ADR-0005). */
  psgcCode: string | null
  name: string
  normalizedName: string
}

const municipalitySchema = new Schema<MunicipalityDoc>(
  {
    ...baseFields,
    psgcCode: { type: String, default: null },
    name: { type: String, required: true },
    normalizedName: { type: String, required: true },
  },
  { ...baseOptions, collection: 'municipalities' },
)
municipalitySchema.plugin(softDelete)
municipalitySchema.index({ normalizedName: 1 }, uniqueAmongAlive)
municipalitySchema.pre('validate', function () {
  this.normalizedName = normalizeName(this.name)
})

export const Municipality = model<MunicipalityDoc>('Municipality', municipalitySchema)

export interface BarangayDoc extends BaseDoc {
  psgcCode: string | null
  name: string
  normalizedName: string
  municipalityId: string
  /** False when created from an import rather than the official PSGC list. */
  isVerified: boolean
}

const barangaySchema = new Schema<BarangayDoc>(
  {
    ...baseFields,
    psgcCode: { type: String, default: null },
    name: { type: String, required: true },
    normalizedName: { type: String, required: true },
    municipalityId: { type: String, required: true },
    isVerified: { type: Boolean, default: false },
  },
  { ...baseOptions, collection: 'barangays' },
)
barangaySchema.plugin(softDelete)
barangaySchema.index({ municipalityId: 1, normalizedName: 1 }, uniqueAmongAlive)
barangaySchema.pre('validate', function () {
  this.normalizedName = normalizeName(this.name)
})

export const Barangay = model<BarangayDoc>('Barangay', barangaySchema)
