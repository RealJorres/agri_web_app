import { z } from 'zod'

import type { FarmerDetail } from './api'

export const PRIVACY_NOTICE =
  'The Provincial Agriculture Office of Marinduque collects this information to register farmers ' +
  'for agricultural programs and services, under the Data Privacy Act of 2012 (RA 10173). It is ' +
  'shared only with authorised staff and is kept only as long as needed. The farmer may ask to ' +
  'see, correct or erase their data at any time.'

const thisYear = new Date().getFullYear()
export const optionalYear = z
  .string()
  .trim()
  .refine((v) => v === '' || (/^\d{4}$/.test(v) && Number(v) >= 1900 && Number(v) <= thisYear), {
    message: `Enter a year between 1900 and ${String(thisYear)}.`,
  })

export const farmerSchema = z
  .object({
    first_name: z.string().trim().max(100),
    middle_name: z.string().trim().max(100),
    last_name: z.string().trim().max(100),
    suffix: z.string().trim().max(20),
    sex: z.enum(['', 'male', 'female']),
    birth_year: optionalYear,
    rsbsa_no: z.string().trim().max(40),
    contact_no: z
      .string()
      .trim()
      .refine(
        (v) => v === '' || /^[0-9+\-\s;/()]{7,40}$/.test(v),
        'Use digits only, e.g. 0917 123 4567.',
      ),
    municipality: z.string().min(1, 'Choose the municipality.'),
    home_barangay: z.string().min(1, 'Choose the home barangay.'),
    status: z.enum(['active', 'inactive', 'needs_review']),
    consent_given: z.boolean(),
    has_consent: z.boolean(),
  })
  .refine((v) => v.first_name || v.last_name, {
    path: ['last_name'],
    message: 'Enter the farmer’s name.',
  })
  .refine((v) => v.has_consent || v.consent_given, {
    path: ['consent_given'],
    message: 'Read the privacy notice to the farmer and record their consent.',
  })

export type FarmerFormValues = z.infer<typeof farmerSchema>
export const FIELDS = Object.keys(farmerSchema.shape) as (keyof FarmerFormValues)[]

export function defaults(farmer?: FarmerDetail): FarmerFormValues {
  return {
    first_name: farmer?.first_name ?? '',
    middle_name: farmer?.middle_name ?? '',
    last_name: farmer?.last_name ?? '',
    suffix: farmer?.suffix ?? '',
    sex: (farmer?.sex ?? '') as FarmerFormValues['sex'], // API returns '' when not recorded
    birth_year: farmer?.birth_year ? String(farmer.birth_year) : '',
    rsbsa_no: farmer?.rsbsa_no ?? '',
    contact_no: farmer?.contact_no ?? '',
    municipality: farmer?.municipality.id ?? '',
    home_barangay: farmer?.home_barangay.id ?? '',
    status: farmer?.status ?? 'active',
    consent_given: false,
    has_consent: farmer?.has_consent ?? false,
  }
}
