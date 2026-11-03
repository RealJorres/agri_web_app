/** Builds docs/data-dictionary.md from the Mongoose models, so it cannot drift from them. */
import type { SchemaType } from 'mongoose'

type Index = [Record<string, unknown>, { unique?: unknown }]

/** The part of a Mongoose model this needs. */
export interface DictionaryModel {
  collection: { name: string }
  schema: { paths: object; indexes: () => Index[] }
}

const camel = (name: string) => name.replace(/_(\w)/gu, (_, letter: string) => letter.toUpperCase())

/** Personal data under RA 10173, by collection. */
export function personalFields(
  farmer: readonly string[],
  farm: readonly string[],
): Record<string, ReadonlySet<string>> {
  return {
    users: new Set(['email', 'passwordHash', 'firstName', 'lastName']),
    farmers: new Set(farmer.map(camel)),
    farms: new Set(farm.map(camel)),
    signatories: new Set(['name']),
  }
}

const BASE_FIELDS = new Set([
  '_id',
  'createdAt',
  'updatedAt',
  'createdBy',
  'updatedBy',
  'isDeleted',
  'deletedAt',
  'deletedBy',
  'writeGuard',
])

function typeOf(path: SchemaType): string {
  const { instance } = path as SchemaType & { instance: string; caster?: { instance?: string } }
  if (instance === 'Array') {
    const inner = (path as unknown as { caster?: { instance?: string } }).caster?.instance
    return `Array of ${inner ?? 'Mixed'}`
  }
  return instance === 'Embedded' ? 'Object' : instance
}

function noteOf(name: string, path: SchemaType, schema: DictionaryModel['schema']): string {
  const { options } = path as SchemaType & {
    options: { enum?: readonly unknown[]; maxlength?: number; select?: boolean }
  }
  const notes: string[] = []
  if (options.enum) notes.push(`one of: ${options.enum.join(', ')}`)
  if (options.maxlength) notes.push(`at most ${String(options.maxlength)} characters`)
  if (options.select === false) notes.push('left out of queries unless asked for')
  const unique = schema
    .indexes()
    .some(
      ([keys, index]) =>
        index.unique === true && Object.keys(keys)[0] === name && Object.keys(keys).length === 1,
    )
  if (unique) notes.push('unique')
  return notes.join('; ')
}

export function buildDataDictionary(
  models: readonly DictionaryModel[],
  personal: Record<string, ReadonlySet<string>>,
): string {
  const lines = [
    '# Data dictionary',
    '',
    'Generated from the Mongoose models by `npm run data-dictionary -w server`. Do not edit by hand.',
    '',
    '**PII** marks personal data under RA 10173: never in fixtures, logs or git; masked in the audit',
    'log (ADR-0006); hidden from roles without `view_personal_data`.',
    '',
    'Documents have a UUID string `_id`. Most also have `createdAt`, `updatedAt`, `createdBy`,',
    '`updatedBy`, `isDeleted`, `deletedAt` and `deletedBy` (soft delete, ADR-0006), which are not',
    'repeated below. A field ending in `Id` holds the `_id` of another document: MongoDB does not',
    'enforce these, so the services do, and `npm run integrity -w server` checks them.',
    '',
  ]
  const sorted = [...models].sort((a, b) => a.collection.name.localeCompare(b.collection.name))
  for (const model of sorted) {
    const name = model.collection.name
    const marked = personal[name] ?? new Set<string>()
    lines.push(
      `## \`${name}\``,
      '',
      '| Field | Type | Required | PII | Notes |',
      '|---|---|---|---|---|',
    )
    const paths = Object.entries(model.schema.paths as Record<string, SchemaType>)
    for (const [field, path] of paths.sort(([a], [b]) => a.localeCompare(b))) {
      if (BASE_FIELDS.has(field)) continue
      const required = (path as SchemaType & { isRequired?: boolean }).isRequired ? 'yes' : ''
      const pii = marked.has(field) ? '**PII**' : ''
      lines.push(
        `| \`${field}\` | ${typeOf(path)} | ${required} | ${pii} | ${noteOf(field, path, model.schema)} |`,
      )
    }
    const indexes = model.schema
      .indexes()
      .filter(([keys]) => Object.keys(keys).length > 1)
      .map(([keys, options]) => {
        const fields = Object.keys(keys).join(', ')
        return options.unique === true ? `\`${fields}\` (unique)` : `\`${fields}\``
      })
    if (indexes.length > 0) lines.push('', `Indexes: ${indexes.join('; ')}`)
    lines.push('')
  }
  return lines.join('\n')
}
