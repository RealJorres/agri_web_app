import type { PageRequest } from '../lib/pagination.js'
import { User } from '../models/account.models.js'
import { AuditLog } from '../models/auditLog.model.js'

/** The history of one object, newest first. The caller has already checked the object's scope. */
export async function auditTrail(objectType: string, objectId: string, request: PageRequest) {
  const filter = { objectType, objectId }
  const [count, entries] = await Promise.all([
    AuditLog.countDocuments(filter),
    AuditLog.find(filter)
      .sort({ createdAt: -1, _id: 1 })
      .skip(request.skip)
      .limit(request.pageSize)
      .lean(),
  ])
  const actorIds = entries.flatMap((entry) => (entry.actorId ? [entry.actorId] : []))
  const actors = await User.find({ _id: { $in: actorIds } }).lean()
  const actorName = new Map(
    actors.map((actor) => [
      actor._id,
      `${actor.firstName} ${actor.lastName}`.trim() || actor.email,
    ]),
  )
  return {
    count,
    results: entries.map((entry) => ({
      id: entry._id,
      created_at: entry.createdAt.toISOString(),
      actor: entry.actorId ? (actorName.get(entry.actorId) ?? null) : null,
      action: entry.action,
      object_type: entry.objectType,
      object_id: entry.objectId,
      before: entry.before,
      after: entry.after,
    })),
  }
}
