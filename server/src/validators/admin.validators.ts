import { z } from 'zod'

import { MEASURE_TYPES } from '../models/catalog.models.js'
import { REPORT_KINDS } from '../models/report.models.js'
import { ALL_ROLES } from '../lib/roles.js'
import { decimal, filterId, id, integer, text } from './common.js'

const required = (max: number) => text(max).min(1, 'Required.')
const email = z.email('Enter a valid email address.').max(254)
const code = (max: number) =>
  z
    .string()
    .trim()
    .toUpperCase()
    .max(max, `At most ${String(max)} characters.`)
    .regex(/^[A-Z0-9][A-Z0-9_-]*$/u, 'Use letters, digits, _ and - only.')
const aliases = z.array(text(100)).max(100)
const order = integer(0, 10_000)
const spacing = decimal({ maxDigits: 6, places: 2 })
const multiplier = decimal({ maxDigits: 6, places: 2 })
const density = integer(1, 10_000_000)
const emptyNull = (value: unknown) => (value === '' ? null : value)

export const userQuery = z.object({ q: z.string().optional() })

export const createUserBody = z.object({
  email,
  password: z.string().min(1, 'Required.').max(256),
  first_name: text(150).optional(),
  last_name: text(150).optional(),
})

export const updateUserBody = z.object({
  email: email.optional(),
  first_name: text(150).optional(),
  last_name: text(150).optional(),
  is_active: z.boolean().optional(),
})

export const passwordBody = z.object({ password: z.string().min(1, 'Required.').max(256) })

export const assignmentBody = z.object({
  role: z.enum(ALL_ROLES),
  municipality: id.nullable().optional(),
  program: id.nullable().optional(),
  barangays: z.array(id).max(500).optional(),
})

export const varietyListQuery = z.object({ commodity: filterId })

export const createProgramBody = z.object({ code: code(20), name: required(200) })
export const updateProgramBody = z.object({ name: required(200) })

export const createCommodityBody = z.object({
  program: id,
  code: code(30),
  name: required(100),
  measure_type: z.enum(MEASURE_TYPES),
  spacing_m: z.preprocess(emptyNull, spacing.nullable().optional()),
  plants_per_ha: z.preprocess(emptyNull, density.nullable().optional()),
  outlier_multiplier: multiplier.optional(),
  attributes_schema: z.record(z.string(), z.unknown()).optional(),
})

export const updateCommodityBody = createCommodityBody.omit({ code: true }).partial()

export const createStageBody = z.object({
  code: code(30),
  label: required(100),
  sort_order: order,
  is_bearing: z.boolean().optional(),
  aliases: aliases.optional(),
})

export const updateStageBody = createStageBody.omit({ code: true }).partial()

export const createVarietyBody = z.object({
  commodity: id,
  code: code(30),
  name: required(100),
  aliases: aliases.optional(),
})

export const updateVarietyBody = z.object({
  name: required(100).optional(),
  aliases: aliases.optional(),
})

export const createSourceBody = z.object({
  code: code(30),
  name: required(100),
  aliases: aliases.optional(),
})

export const updateSourceBody = updateVarietyBody

export const updateReportSettingsBody = z.object({
  letterhead: z.string().trim().min(1, 'Required.').max(1000).optional(),
  program_line: text(200).optional(),
})

export const createSignatoryBody = z.object({
  report_kind: z.enum(REPORT_KINDS),
  order,
  caption: required(60),
  name: required(120),
  title: text(160).optional(),
})

export const updateSignatoryBody = createSignatoryBody.omit({ report_kind: true }).partial()
