import { model, Schema } from 'mongoose'

import type { ScopePaths } from '../lib/scoping.js'
import { collapseSpaces, normalizeName, normalizePersonName } from '../lib/text.js'
import {
  baseFields,
  baseOptions,
  softDelete,
  uniqueAmongAlive,
  writeGuardField,
  type BaseDoc,
} from './base.js'

export const SEXES = ['male', 'female'] as const
export const FARMER_STATUSES = ['active', 'inactive', 'needs_review'] as const
export type FarmerStatus = (typeof FARMER_STATUSES)[number]

/** Personal fields under RA 10173, by their API name: masked in audit entries. */
export const FARMER_PERSONAL_FIELDS = [
  'first_name',
  'middle_name',
  'last_name',
  'suffix',
  'full_name_raw',
  'normalized_name', // derived from the name, so just as personal
  'sex',
  'birth_year',
  'rsbsa_no',
  'contact_no',
] as const

export interface FarmerDoc extends BaseDoc {
  firstName: string
  middleName: string
  lastName: string
  suffix: string
  /** The name exactly as captured at the source, such as a legacy workbook cell. */
  fullNameRaw: string
  normalizedName: string
  sex: string
  birthYear: number | null
  /** Null, not empty, when unknown, so the unique index ignores it. */
  rsbsaNo: string | null
  contactNo: string
  homeBarangayId: string
  /** Copied from the home barangay, for scoping (ADR-0019). */
  municipalityId: string
  consentAt: Date | null
  consentById: string | null
  status: FarmerStatus
  mergedIntoId: string | null
  writeGuard: number
}

export const FARMER_SCOPE: ScopePaths = {
  barangay: 'homeBarangayId',
  municipality: 'municipalityId',
}

type NameParts = Pick<FarmerDoc, 'firstName' | 'middleName' | 'lastName' | 'suffix' | 'fullNameRaw'>

export function farmerDisplayName(farmer: NameParts): string {
  const parts = [farmer.firstName, farmer.middleName, farmer.lastName, farmer.suffix]
  return collapseSpaces(parts.filter(Boolean).join(' ')) || farmer.fullNameRaw
}

const farmerSchema = new Schema<FarmerDoc>(
  {
    ...baseFields,
    ...writeGuardField,
    firstName: { type: String, default: '', maxlength: 100 },
    middleName: { type: String, default: '', maxlength: 100 },
    lastName: { type: String, default: '', maxlength: 100 },
    suffix: { type: String, default: '', maxlength: 20 },
    fullNameRaw: { type: String, default: '', maxlength: 300 },
    normalizedName: { type: String, default: '' },
    sex: { type: String, default: '', enum: ['', ...SEXES] },
    birthYear: { type: Number, default: null, min: 1900, max: 2100 },
    rsbsaNo: { type: String, default: null, maxlength: 40 },
    contactNo: { type: String, default: '', maxlength: 40 },
    homeBarangayId: { type: String, required: true },
    municipalityId: { type: String, required: true },
    consentAt: { type: Date, default: null },
    consentById: { type: String, default: null },
    status: { type: String, default: 'active', enum: FARMER_STATUSES },
    mergedIntoId: { type: String, default: null },
  },
  { ...baseOptions, collection: 'farmers' },
)
farmerSchema.plugin(softDelete)
farmerSchema.index(
  { rsbsaNo: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false, rsbsaNo: { $type: 'string' } } },
)
farmerSchema.index({ municipalityId: 1, normalizedName: 1 })
farmerSchema.index({ homeBarangayId: 1 })
farmerSchema.pre('validate', function () {
  this.normalizedName = normalizePersonName(farmerDisplayName(this))
})

export const Farmer = model<FarmerDoc>('Farmer', farmerSchema)

export const ASSOCIATION_TYPES = [
  'farmers_association',
  'cooperative',
  'irrigators_association',
  'other',
] as const

export interface AssociationDoc extends BaseDoc {
  name: string
  normalizedName: string
  shortName: string
  type: (typeof ASSOCIATION_TYPES)[number]
  municipalityId: string
  registrationBody: string
  registrationNo: string
  writeGuard: number
}

export const ASSOCIATION_SCOPE: ScopePaths = { municipality: 'municipalityId' }

const associationSchema = new Schema<AssociationDoc>(
  {
    ...baseFields,
    ...writeGuardField,
    name: { type: String, required: true, maxlength: 200 },
    normalizedName: { type: String, required: true },
    shortName: { type: String, default: '', maxlength: 50 },
    type: { type: String, default: 'farmers_association', enum: ASSOCIATION_TYPES },
    municipalityId: { type: String, required: true },
    registrationBody: { type: String, default: '', maxlength: 100 },
    registrationNo: { type: String, default: '', maxlength: 60 },
  },
  { ...baseOptions, collection: 'associations' },
)
associationSchema.plugin(softDelete)
associationSchema.index({ municipalityId: 1, normalizedName: 1 }, uniqueAmongAlive)
associationSchema.pre('validate', function () {
  this.normalizedName = normalizeName(this.name)
})

export const Association = model<AssociationDoc>('Association', associationSchema)

export interface AssociationMemberDoc extends BaseDoc {
  farmerId: string
  associationId: string
  role: string
  since: Date | null
}

const associationMemberSchema = new Schema<AssociationMemberDoc>(
  {
    ...baseFields,
    farmerId: { type: String, required: true },
    associationId: { type: String, required: true },
    role: { type: String, default: '', maxlength: 60 },
    since: { type: Date, default: null },
  },
  { ...baseOptions, collection: 'association_members' },
)
associationMemberSchema.plugin(softDelete)
associationMemberSchema.index({ farmerId: 1, associationId: 1 }, uniqueAmongAlive)
associationMemberSchema.index({ associationId: 1 })

export const AssociationMember = model<AssociationMemberDoc>(
  'AssociationMember',
  associationMemberSchema,
)
