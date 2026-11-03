import { randomUUID } from 'node:crypto'

import type { ClientSession, Model, Query, Schema } from 'mongoose'

/** Fields every record has: UUID key, timestamps, actors and soft delete (ADR-0006, ADR-0019). */
export interface BaseDoc {
  _id: string
  createdAt: Date
  updatedAt: Date
  createdBy: string | null
  updatedBy: string | null
  isDeleted: boolean
  deletedAt: Date | null
  deletedBy: string | null
}

export const baseFields = {
  _id: { type: String, default: () => randomUUID() },
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null },
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
  deletedBy: { type: String, default: null },
}

export const baseOptions = { timestamps: true, versionKey: false } as const

/** Options for a unique index that ignores soft-deleted documents. */
export const uniqueAmongAlive = {
  unique: true,
  partialFilterExpression: { isDeleted: false },
} as const

const HIDDEN_BY_DEFAULT = [
  'find',
  'findOne',
  'countDocuments',
  'findOneAndUpdate',
  'updateOne',
  'updateMany',
] as const

/** A soft delete, recorded on the document. The caller saves it inside its transaction. */
export function markDeleted(
  doc: Pick<BaseDoc, 'isDeleted' | 'deletedAt' | 'deletedBy' | 'updatedBy'>,
  actorId: string | null,
): void {
  doc.isDeleted = true
  doc.deletedAt = new Date()
  doc.deletedBy = actorId
  doc.updatedBy = actorId
}

/** For parents that other documents point at: a counter that lockForWrite bumps. */
export const writeGuardField = { writeGuard: { type: Number, default: 0 } }

/**
 * MongoDB has no foreign keys, so "still exists" and "has no children" checks could otherwise pass
 * in two concurrent transactions and leave an orphan. Writing to the parent makes such transactions
 * conflict, and the driver retries the loser, which then sees the other's result. Returns false
 * when the parent is missing or soft-deleted.
 */
export async function lockForWrite<Doc extends BaseDoc>(
  model: Model<Doc>,
  id: string,
  session: ClientSession,
): Promise<boolean> {
  const result = await model.updateOne(
    { _id: id } as never,
    { $inc: { writeGuard: 1 } },
    {
      session,
      timestamps: false,
    },
  )
  return result.matchedCount > 0
}

/**
 * Hides soft-deleted documents from queries, unless the filter names isDeleted itself. Aggregation
 * pipelines are not covered, so they must match on isDeleted: false explicitly.
 */
export function softDelete(schema: Schema): void {
  for (const operation of HIDDEN_BY_DEFAULT) {
    schema.pre(operation, function (this: Query<unknown, unknown>) {
      if (!('isDeleted' in this.getFilter())) void this.where({ isDeleted: false })
    })
  }
}
