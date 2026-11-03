/** Writes audit entries, always inside the same transaction as the change they describe. */
import type { ClientSession } from 'mongoose'

import { currentRequestMeta } from '../lib/requestContext.js'
import { AuditLog } from '../models/auditLog.model.js'

export const REDACTED = '[personal]'

type Values = Record<string, unknown>

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === ''
}

/** Replaces personal values with a marker; empty stays empty (ADR-0006). */
export function mask(values: Values, personal: Iterable<string>): Values {
  const hidden = new Set(personal)
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      if (!hidden.has(key)) return [key, value]
      return [key, isEmpty(value) ? null : REDACTED]
    }),
  )
}

function comparable(value: unknown): string {
  return JSON.stringify(value ?? null)
}

/**
 * Changed keys only, compared on raw values and then masked: a personal field shows that it
 * changed, but never what it was or became.
 */
export function changes(
  before: Values,
  after: Values,
  personal: Iterable<string> = [],
): { before: Values; after: Values } {
  const keys = Object.keys(after).filter(
    (key) => comparable(before[key]) !== comparable(after[key]),
  )
  const pick = (values: Values): Values =>
    Object.fromEntries(keys.map((key) => [key, values[key] ?? null]))
  return { before: mask(pick(before), personal), after: mask(pick(after), personal) }
}

export interface AuditEntry {
  actorId: string | null
  action: string
  objectType: string
  objectId: string
  before?: Values | null
  after?: Values | null
  /** Required: an audit entry must commit or roll back together with its change (rule 5). */
  session: ClientSession
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
  const { session, before = null, after = null, ...fields } = entry
  const { ip, userAgent } = currentRequestMeta()
  await AuditLog.create([{ ...fields, before, after, ip, userAgent }], { session })
}
