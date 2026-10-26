import { z } from 'zod'

import type { Harvest, HarvestInput } from './api'

export const UNIT_LABELS = { kg: 'kg', sack: 'sack', other: 'other unit' } as const
export const FORM_LABELS = {
  wet_beans: 'Wet beans',
  dried_beans: 'Dried beans',
  pods: 'Pods',
  unknown: 'Form not recorded',
} as const

const decimal = /^\d+(\.\d{1,3})?$/
const money = /^\d+(\.\d{1,2})?$/
const today = () => new Date().toISOString().slice(0, 10)

export const harvestSchema = z
  .object({
    harvest_date: z
      .string()
      .refine((v) => v === '' || v <= today(), 'The harvest date cannot be in the future.'),
    date_estimated: z.boolean(),
    quantity: z
      .string()
      .trim()
      .refine((v) => decimal.test(v) && Number(v) > 0, 'Enter a quantity above 0, e.g. 8 or 2.5.'),
    unit: z.enum(['kg', 'sack', 'other']),
    product_form: z.enum(['wet_beans', 'dried_beans', 'pods', 'unknown']),
    price_per_unit: z
      .string()
      .trim()
      .refine((v) => v === '' || money.test(v), 'Enter a price in pesos, e.g. 150 or 150.50.'),
    buyer: z.string().trim().max(150),
  })
  .strict()

export type HarvestValues = z.infer<typeof harvestSchema>

export const HARVEST_FIELDS = Object.keys(harvestSchema.shape)

export function toValues(h?: Harvest): HarvestValues {
  return {
    harvest_date: h?.harvest_date ?? '',
    date_estimated: h ? Boolean(h.date_estimated && h.harvest_date) : false,
    quantity: h ? String(Number(h.quantity)) : '',
    unit: h?.unit ?? 'kg',
    product_form: h?.product_form ?? 'dried_beans',
    price_per_unit: h?.price_per_unit ? String(Number(h.price_per_unit)) : '',
    buyer: h?.buyer ?? '',
  }
}

/** Without a date the harvest is always "date estimated" (brief §5). */
export function toBody(v: HarvestValues): HarvestInput {
  return {
    harvest_date: v.harvest_date || null,
    date_estimated: v.harvest_date ? v.date_estimated : true,
    quantity: v.quantity,
    unit: v.unit,
    product_form: v.product_form,
    price_per_unit: v.price_per_unit || null,
    buyer: v.buyer,
  }
}
