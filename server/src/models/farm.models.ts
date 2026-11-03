import { model, Schema, type Types } from 'mongoose'

import { COPIED_SCOPE_PATHS, type ScopePaths } from '../lib/scoping.js'
import {
  baseFields,
  baseOptions,
  softDelete,
  uniqueAmongAlive,
  writeGuardField,
  type BaseDoc,
} from './base.js'

export const TENURES = ['owner', 'tenant', 'lessee', 'arb', 'other'] as const

/** A farm's location is personal data, because it locates a person's land. By API name. */
export const FARM_PERSONAL_FIELDS = ['sitio', 'location', 'location_raw'] as const

export interface GeoPoint {
  type: 'Point'
  /** Longitude, then latitude (GeoJSON order, WGS84). */
  coordinates: [number, number]
}

export interface FarmDoc extends BaseDoc {
  farmerId: string
  barangayId: string
  /** Copied from the barangay, for scoping (ADR-0019). */
  municipalityId: string
  sitio: string
  location: GeoPoint | null
  declaredAreaHa: Types.Decimal128 | null
  tenure: string
  /** Location text as written at the source. */
  locationRaw: string
  writeGuard: number
}

export const FARM_SCOPE: ScopePaths = { barangay: 'barangayId', municipality: 'municipalityId' }

const geoPointSchema = new Schema<GeoPoint>(
  {
    type: { type: String, enum: ['Point'], required: true },
    coordinates: { type: [Number], required: true },
  },
  { _id: false },
)

const farmSchema = new Schema<FarmDoc>(
  {
    ...baseFields,
    ...writeGuardField,
    farmerId: { type: String, required: true },
    barangayId: { type: String, required: true },
    municipalityId: { type: String, required: true },
    sitio: { type: String, default: '', maxlength: 100 },
    location: { type: geoPointSchema, default: null },
    declaredAreaHa: { type: Schema.Types.Decimal128, default: null },
    tenure: { type: String, default: '', enum: ['', ...TENURES] },
    locationRaw: { type: String, default: '' },
  },
  { ...baseOptions, collection: 'farms' },
)
farmSchema.plugin(softDelete)
farmSchema.index({ farmerId: 1 })
farmSchema.index({ barangayId: 1 })
farmSchema.index({ municipalityId: 1 })

export const Farm = model<FarmDoc>('Farm', farmSchema)

/** Location and program keys copied onto everything under a farm (ADR-0019). */
export interface CopiedScope {
  barangayId: string
  municipalityId: string
  programId: string
}

const copiedScopeFields = {
  barangayId: { type: String, required: true },
  municipalityId: { type: String, required: true },
  programId: { type: String, required: true },
}

export const COPIED_SCOPE: ScopePaths = COPIED_SCOPE_PATHS

/** One commodity grown on one farm. Inventory counts attach here (brief §6). */
export interface CropStandDoc extends BaseDoc, CopiedScope {
  farmId: string
  commodityId: string
  spacingM: Types.Decimal128 | null
  attributes: Record<string, unknown>
  writeGuard: number
}

const cropStandSchema = new Schema<CropStandDoc>(
  {
    ...baseFields,
    ...writeGuardField,
    ...copiedScopeFields,
    farmId: { type: String, required: true },
    commodityId: { type: String, required: true },
    spacingM: { type: Schema.Types.Decimal128, default: null },
    attributes: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  // minimize: false keeps empty attributes instead of dropping the field.
  { ...baseOptions, collection: 'crop_stands', minimize: false },
)
cropStandSchema.plugin(softDelete)
cropStandSchema.index({ farmId: 1, commodityId: 1 }, uniqueAmongAlive)
cropStandSchema.index({ municipalityId: 1 })

export const CropStand = model<CropStandDoc>('CropStand', cropStandSchema)

/** A planting batch: when, from what source, which varieties. Not counted per stage. */
export interface PlantingDoc extends BaseDoc, CopiedScope {
  cropStandId: string
  yearPlanted: number | null
  sourceId: string | null
  qtyPlanted: number | null
  notes: string
  varietyIds: string[]
}

const plantingSchema = new Schema<PlantingDoc>(
  {
    ...baseFields,
    ...copiedScopeFields,
    cropStandId: { type: String, required: true },
    yearPlanted: { type: Number, default: null, min: 1900, max: 2100 },
    sourceId: { type: String, default: null },
    qtyPlanted: { type: Number, default: null, min: 0 },
    notes: { type: String, default: '' },
    varietyIds: { type: [String], default: [] },
  },
  { ...baseOptions, collection: 'plantings' },
)
plantingSchema.plugin(softDelete)
plantingSchema.index({ cropStandId: 1 })

export const Planting = model<PlantingDoc>('Planting', plantingSchema)

export const HARVEST_UNITS = ['kg', 'sack', 'other'] as const
export const PRODUCT_FORMS = ['wet_beans', 'dried_beans', 'pods', 'unknown'] as const

export interface HarvestDoc extends BaseDoc, CopiedScope {
  cropStandId: string
  harvestDate: Date | null
  /** True when the date is unknown or approximate, as with legacy remarks. */
  dateEstimated: boolean
  quantity: Types.Decimal128
  unit: (typeof HARVEST_UNITS)[number]
  productForm: (typeof PRODUCT_FORMS)[number]
  pricePerUnit: Types.Decimal128 | null
  buyer: string
  /** Source text the harvest was parsed from. */
  rawText: string
}

const harvestSchema = new Schema<HarvestDoc>(
  {
    ...baseFields,
    ...copiedScopeFields,
    cropStandId: { type: String, required: true },
    harvestDate: { type: Date, default: null },
    dateEstimated: { type: Boolean, default: false },
    quantity: { type: Schema.Types.Decimal128, required: true },
    unit: { type: String, required: true, enum: HARVEST_UNITS },
    productForm: { type: String, default: 'unknown', enum: PRODUCT_FORMS },
    pricePerUnit: { type: Schema.Types.Decimal128, default: null },
    buyer: { type: String, default: '', maxlength: 150 },
    rawText: { type: String, default: '' },
  },
  { ...baseOptions, collection: 'harvests' },
)
harvestSchema.plugin(softDelete)
harvestSchema.index({ cropStandId: 1 })
harvestSchema.index({ municipalityId: 1 })

export const Harvest = model<HarvestDoc>('Harvest', harvestSchema)
