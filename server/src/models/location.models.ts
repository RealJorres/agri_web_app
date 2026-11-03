import { model, Schema } from 'mongoose'

import { normalizeName } from '../lib/text.js'
import { baseFields, baseOptions, softDelete, uniqueAmongAlive, type BaseDoc } from './base.js'

// A code is unique once it exists; many rows may still have none.
const uniqueOnceCoded = {
  unique: true,
  partialFilterExpression: { psgcCode: { $type: 'string' } },
} as const

/** GeoJSON in WGS84, with longitude first. Large, so queries leave it out unless they ask. */
export interface MultiPolygon {
  type: 'MultiPolygon'
  coordinates: number[][][][]
}

const boundaryField = { type: Schema.Types.Mixed, default: null, select: false }

export interface MunicipalityDoc extends BaseDoc {
  /** Empty until the official PSGC file is loaded; codes are never invented (ADR-0005). */
  psgcCode: string | null
  name: string
  normalizedName: string
  boundary?: MultiPolygon | null
}

const municipalitySchema = new Schema<MunicipalityDoc>(
  {
    ...baseFields,
    psgcCode: { type: String, default: null },
    name: { type: String, required: true },
    normalizedName: { type: String, required: true },
    boundary: boundaryField,
  },
  { ...baseOptions, collection: 'municipalities' },
)
municipalitySchema.plugin(softDelete)
municipalitySchema.index({ normalizedName: 1 }, uniqueAmongAlive)
municipalitySchema.index({ psgcCode: 1 }, uniqueOnceCoded)
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
  boundary?: MultiPolygon | null
}

const barangaySchema = new Schema<BarangayDoc>(
  {
    ...baseFields,
    psgcCode: { type: String, default: null },
    name: { type: String, required: true },
    normalizedName: { type: String, required: true },
    municipalityId: { type: String, required: true },
    isVerified: { type: Boolean, default: false },
    boundary: boundaryField,
  },
  { ...baseOptions, collection: 'barangays' },
)
barangaySchema.plugin(softDelete)
barangaySchema.index({ municipalityId: 1, normalizedName: 1 }, uniqueAmongAlive)
barangaySchema.index({ psgcCode: 1 }, uniqueOnceCoded)
barangaySchema.pre('validate', function () {
  this.normalizedName = normalizeName(this.name)
})

export const Barangay = model<BarangayDoc>('Barangay', barangaySchema)
