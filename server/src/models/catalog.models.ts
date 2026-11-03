/** Commodity catalog. New crops are rows here, not code (brief §1). */
import { model, Schema, type Types } from 'mongoose'

import { baseFields, baseOptions, softDelete, uniqueAmongAlive, type BaseDoc } from './base.js'

// Other spellings seen in source data, matched after normalization.
const aliases = { type: [{ type: String, maxlength: 100 }], default: [] }

export interface ProgramDoc extends BaseDoc {
  code: string
  name: string
}

const programSchema = new Schema<ProgramDoc>(
  {
    ...baseFields,
    code: { type: String, required: true, maxlength: 20 },
    name: { type: String, required: true, maxlength: 200 },
  },
  { ...baseOptions, collection: 'programs' },
)
programSchema.plugin(softDelete)
programSchema.index({ code: 1 }, uniqueAmongAlive)

export const Program = model<ProgramDoc>('Program', programSchema)

export const MEASURE_TYPES = ['trees', 'area'] as const
export type MeasureType = (typeof MEASURE_TYPES)[number]

export interface CommodityDoc extends BaseDoc {
  programId: string
  code: string
  name: string
  measureType: MeasureType
  spacingM: Types.Decimal128 | null
  plantsPerHa: number | null
  /** JSON Schema for a crop stand's attributes, checked in catalog.service. */
  attributesSchema: Record<string, unknown>
  outlierMultiplier: Types.Decimal128
}

const commoditySchema = new Schema<CommodityDoc>(
  {
    ...baseFields,
    programId: { type: String, required: true },
    code: { type: String, required: true, maxlength: 30 },
    name: { type: String, required: true, maxlength: 100 },
    measureType: { type: String, required: true, enum: MEASURE_TYPES },
    spacingM: { type: Schema.Types.Decimal128, default: null },
    plantsPerHa: { type: Number, default: null, min: 0 },
    attributesSchema: { type: Schema.Types.Mixed, default: () => ({}) },
    outlierMultiplier: { type: Schema.Types.Decimal128, required: true, default: '5' },
  },
  // minimize: false keeps an empty attributes schema instead of dropping the field.
  { ...baseOptions, collection: 'commodities', minimize: false },
)
commoditySchema.plugin(softDelete)
commoditySchema.index({ code: 1 }, uniqueAmongAlive)
commoditySchema.index({ programId: 1 })

export const Commodity = model<CommodityDoc>('Commodity', commoditySchema)

export interface GrowthStageDoc extends BaseDoc {
  commodityId: string
  code: string
  label: string
  sortOrder: number
  isBearing: boolean
  aliases: string[]
}

const growthStageSchema = new Schema<GrowthStageDoc>(
  {
    ...baseFields,
    commodityId: { type: String, required: true },
    code: { type: String, required: true, maxlength: 30 },
    label: { type: String, required: true, maxlength: 100 },
    sortOrder: { type: Number, required: true, min: 0 },
    isBearing: { type: Boolean, default: false },
    aliases,
  },
  { ...baseOptions, collection: 'growth_stages' },
)
growthStageSchema.plugin(softDelete)
growthStageSchema.index({ commodityId: 1, code: 1 }, uniqueAmongAlive)
growthStageSchema.index({ commodityId: 1, sortOrder: 1 }, uniqueAmongAlive)

export const GrowthStage = model<GrowthStageDoc>('GrowthStage', growthStageSchema)

export interface VarietyDoc extends BaseDoc {
  commodityId: string
  code: string
  name: string
  aliases: string[]
}

const varietySchema = new Schema<VarietyDoc>(
  {
    ...baseFields,
    commodityId: { type: String, required: true },
    code: { type: String, required: true, maxlength: 30 },
    name: { type: String, required: true, maxlength: 100 },
    aliases,
  },
  { ...baseOptions, collection: 'varieties' },
)
varietySchema.plugin(softDelete)
varietySchema.index({ commodityId: 1, code: 1 }, uniqueAmongAlive)

export const Variety = model<VarietyDoc>('Variety', varietySchema)

/** Where planting materials came from (for example a regional office, or own produced). */
export interface MaterialSourceDoc extends BaseDoc {
  code: string
  name: string
  aliases: string[]
}

const materialSourceSchema = new Schema<MaterialSourceDoc>(
  {
    ...baseFields,
    code: { type: String, required: true, maxlength: 30 },
    name: { type: String, required: true, maxlength: 100 },
    aliases,
  },
  { ...baseOptions, collection: 'material_sources' },
)
materialSourceSchema.plugin(softDelete)
materialSourceSchema.index({ code: 1 }, uniqueAmongAlive)

export const MaterialSource = model<MaterialSourceDoc>('MaterialSource', materialSourceSchema)

export const UNIT_KINDS = ['mass', 'area', 'count', 'container'] as const
export type UnitKind = (typeof UNIT_KINDS)[number]

export interface UnitDoc extends BaseDoc {
  code: string
  name: string
  kind: UnitKind
  /** Conversion to the kind's base unit (kg, ha). Null when it varies, as with a sack. */
  toBase: Types.Decimal128 | null
  aliases: string[]
}

const unitSchema = new Schema<UnitDoc>(
  {
    ...baseFields,
    code: { type: String, required: true, maxlength: 20 },
    name: { type: String, required: true, maxlength: 50 },
    kind: { type: String, required: true, enum: UNIT_KINDS },
    toBase: { type: Schema.Types.Decimal128, default: null },
    aliases,
  },
  { ...baseOptions, collection: 'units' },
)
unitSchema.plugin(softDelete)
unitSchema.index({ code: 1 }, uniqueAmongAlive)

export const Unit = model<UnitDoc>('Unit', unitSchema)
