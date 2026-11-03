import type { ErrorObject, ValidateFunction } from 'ajv'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ClientSession, Model } from 'mongoose'

import { toDecimal128 } from '../lib/decimal.js'
import { DomainError, type ErrorFields } from '../lib/errors.js'
import { inTransaction } from '../lib/transaction.js'
import {
  Commodity,
  GrowthStage,
  MaterialSource,
  Program,
  Unit,
  Variety,
  type CommodityDoc,
  type GrowthStageDoc,
  type MaterialSourceDoc,
  type VarietyDoc,
} from '../models/catalog.models.js'
import type { BaseDoc } from '../models/base.js'
import { AliasIndex } from '../selectors/catalog.selectors.js'
import { COMMODITIES, MATERIAL_SOURCES, PROGRAMS, UNITS } from './catalog.seedData.js'

// Formats are annotations here, as they were before: a schema's format is not enforced.
const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: false,
  addUsedSchema: false,
})

// Compiling is slow and Ajv keeps what it compiles, so each distinct schema is compiled once.
const compiled = new Map<string, ValidateFunction>()

function compile(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema)
  let validate = compiled.get(key)
  if (!validate) {
    validate = ajv.compile(schema)
    compiled.set(key, validate)
  }
  return validate
}

/** Rejects a commodity's attributes schema if it is not valid JSON Schema (2020-12). */
export function checkAttributesSchema(schema: Record<string, unknown>): void {
  if (Object.keys(schema).length === 0) return
  try {
    compile(schema)
  } catch (error) {
    throw new DomainError('invalid_schema', 'The attributes schema is not valid JSON Schema.', {
      attributes_schema: [error instanceof Error ? error.message : 'Invalid schema.'],
    })
  }
}

function fieldKey(error: ErrorObject): string {
  const path = error.instancePath
    .split('/')
    .filter(Boolean)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .join('.')
  return path ? `attributes.${path}` : 'attributes'
}

function fieldMessage(error: ErrorObject): string {
  const { additionalProperty } = error.params as { additionalProperty?: unknown }
  const message = error.message ?? 'Invalid value.'
  return typeof additionalProperty === 'string' ? `${message}: ${additionalProperty}` : message
}

/** Checks a crop stand's attributes against its commodity's schema, keyed by JSON path. */
export function validateAttributes(
  commodity: Pick<CommodityDoc, 'attributesSchema'>,
  attributes: Record<string, unknown>,
): void {
  if (Object.keys(commodity.attributesSchema).length === 0) return
  const validate = compile(commodity.attributesSchema)
  if (validate(attributes)) return
  const fields: ErrorFields = {}
  for (const error of validate.errors ?? []) {
    ;(fields[fieldKey(error)] ??= []).push(fieldMessage(error))
  }
  throw new DomainError('invalid_attributes', 'Some crop attributes are invalid.', fields)
}

// --- Seeding is idempotent. A re-run updates seeded fields and adds missing aliases, but never
// removes aliases or rows added by administrators.

export interface SeedReport {
  created: Record<string, number>
  updated: Record<string, number>
}

async function upsert<Doc extends BaseDoc>(
  model: Model<Doc>,
  lookup: Record<string, unknown>,
  values: Record<string, unknown>,
  report: SeedReport,
  session: ClientSession,
) {
  const { aliases: seeded, ...fields } = values as { aliases?: string[] }
  const existing = await model.findOne(lookup).session(session)
  const bucket = existing ? report.updated : report.created
  bucket[model.modelName] = (bucket[model.modelName] ?? 0) + 1
  const doc = existing ?? new model(lookup)
  doc.set(fields)
  const current: string[] = (doc.get('aliases') as string[] | undefined) ?? []
  const missing = (seeded ?? []).filter((alias) => !current.includes(alias))
  if (missing.length > 0) doc.set('aliases', [...current, ...missing])
  await doc.save({ session })
  return doc
}

export async function seedCatalog(): Promise<SeedReport> {
  // Checked first, so a bad schema fails before anything is written.
  for (const spec of COMMODITIES) checkAttributesSchema(spec.attributesSchema)
  return inTransaction(async (session) => {
    const report: SeedReport = { created: {}, updated: {} }
    const programIds = new Map<string, string>()
    for (const { code, name } of PROGRAMS) {
      const program = await upsert(Program, { code }, { name }, report, session)
      programIds.set(code, program._id)
    }
    for (const spec of COMMODITIES) {
      const { program, code, stages, varieties, spacingM, outlierMultiplier, ...fields } = spec
      const commodity = await upsert(
        Commodity,
        { code },
        {
          ...fields,
          programId: programIds.get(program),
          spacingM: toDecimal128(spacingM),
          outlierMultiplier: toDecimal128(outlierMultiplier),
        },
        report,
        session,
      )
      const commodityId = commodity._id
      for (const { code: stageCode, ...stage } of stages) {
        const lookup = { commodityId, code: stageCode }
        await upsert(GrowthStage, lookup, stage, report, session)
      }
      for (const { code: varietyCode, ...variety } of varieties) {
        const lookup = { commodityId, code: varietyCode }
        await upsert(Variety, lookup, variety, report, session)
      }
      // An ambiguous alias fails the seed and rolls it back.
      new AliasIndex(
        await GrowthStage.find({ commodityId }).session(session).lean<GrowthStageDoc[]>(),
      )
      new AliasIndex(await Variety.find({ commodityId }).session(session).lean<VarietyDoc[]>())
    }
    for (const { code, ...source } of MATERIAL_SOURCES) {
      await upsert(MaterialSource, { code }, source, report, session)
    }
    new AliasIndex(await MaterialSource.find().session(session).lean<MaterialSourceDoc[]>())
    for (const { code, toBase, ...unit } of UNITS) {
      const values = { ...unit, toBase: toBase === null ? null : toDecimal128(toBase) }
      await upsert(Unit, { code }, values, report, session)
    }
    return report
  })
}
