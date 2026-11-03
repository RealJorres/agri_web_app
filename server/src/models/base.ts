import { randomUUID } from 'node:crypto'

import type { Query, Schema } from 'mongoose'

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
