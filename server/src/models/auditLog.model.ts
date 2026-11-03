import { randomUUID } from 'node:crypto'

import { model, Schema } from 'mongoose'

export class AppendOnlyError extends Error {
  constructor() {
    super('Audit log entries cannot be changed or deleted.')
    this.name = 'AppendOnlyError'
  }
}

/** Personal values are masked before they reach before and after (ADR-0006). */
export interface AuditLogDoc {
  _id: string
  actorId: string | null
  action: string
  objectType: string
  objectId: string
  before: unknown
  after: unknown
  ip: string | null
  userAgent: string
  createdAt: Date
}

const auditLogSchema = new Schema<AuditLogDoc>(
  {
    _id: { type: String, default: () => randomUUID() },
    actorId: { type: String, default: null },
    action: { type: String, required: true, index: true },
    objectType: { type: String, default: '' },
    objectId: { type: String, default: '' },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    ip: { type: String, default: null },
    userAgent: { type: String, default: '' },
    createdAt: { type: Date, default: () => new Date(), index: true },
  },
  { versionKey: false, collection: 'audit_logs' },
)
auditLogSchema.index({ objectType: 1, objectId: 1, createdAt: -1 })

// The application guard. In production the database user also has no update or delete right on
// this collection (see the cutover plan), which stands in for the old database trigger.
const CHANGING_OPERATIONS = [
  'updateOne',
  'updateMany',
  'replaceOne',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'deleteMany',
] as const
for (const operation of CHANGING_OPERATIONS) {
  auditLogSchema.pre(operation, () => {
    throw new AppendOnlyError()
  })
}
auditLogSchema.pre('deleteOne', { document: false, query: true }, () => {
  throw new AppendOnlyError()
})
auditLogSchema.pre('deleteOne', { document: true, query: false }, () => {
  throw new AppendOnlyError()
})
auditLogSchema.pre('save', function () {
  if (!this.isNew) throw new AppendOnlyError()
})

export const AuditLog = model<AuditLogDoc>('AuditLog', auditLogSchema)
