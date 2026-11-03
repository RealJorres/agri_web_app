/**
 * The application's database role (ADR-0022). The audit log can be read and added to, and nothing
 * else, which is what keeps it append-only on MongoDB. A database administrator's account is only for
 * the setup scripts, and the running application never holds one.
 */
import type { Db, MongoClient } from 'mongodb'

export const AUDIT_COLLECTION = 'audit_logs'
const READ_WRITE = ['find', 'insert', 'update', 'remove'] as const
const APPEND_ONLY = ['find', 'insert'] as const
const NOT_AUTHORIZED = 13
const NEVER_MATCHES = '__role_check_never_matches__'

export interface Privilege {
  resource: { db: string; collection: string }
  actions: string[]
}

export function appRolePrivileges(dbName: string, collections: readonly string[]): Privilege[] {
  return [...collections].sort().map((collection) => ({
    resource: { db: dbName, collection },
    actions: [...(collection === AUDIT_COLLECTION ? APPEND_ONLY : READ_WRITE)],
  }))
}

function isRefused(error: unknown): boolean {
  return (error as { code?: unknown }).code === NOT_AUTHORIZED
}

async function refusal(work: () => Promise<unknown>): Promise<boolean> {
  try {
    await work()
    return false
  } catch (error) {
    if (isRefused(error)) return true
    throw error
  }
}

/**
 * Tries what the application does on every collection, and what it must not do on the audit log.
 * Nothing is left behind: updates and deletes match no document, and inserts are rolled back.
 * Returns the problems found, in words that name no secrets.
 */
export async function checkDbRole(
  client: MongoClient,
  db: Db,
  collections: readonly string[],
): Promise<string[]> {
  const problems: string[] = []
  const missing = { _id: NEVER_MATCHES } as never
  for (const name of [...collections].sort()) {
    const collection = db.collection(name)
    if (await refusal(() => collection.findOne(missing))) problems.push(`${name}: cannot read`)
    const session = client.startSession()
    try {
      session.startTransaction()
      const insert = () => collection.insertOne({ _id: NEVER_MATCHES } as never, { session })
      if (await refusal(insert)) problems.push(`${name}: cannot insert`)
    } finally {
      await session.abortTransaction().catch(() => undefined)
      await session.endSession()
    }
    const update = () => collection.updateOne(missing, { $set: { roleCheck: true } })
    const remove = () => collection.deleteOne(missing)
    if (name === AUDIT_COLLECTION) {
      if (!(await refusal(update))) problems.push(`${name}: can be changed, and must not be`)
      if (!(await refusal(remove))) problems.push(`${name}: can be deleted from, and must not be`)
    } else {
      if (await refusal(update)) problems.push(`${name}: cannot update`)
      if (await refusal(remove)) problems.push(`${name}: cannot delete`)
    }
  }
  return problems
}
