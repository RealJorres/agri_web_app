import { AsyncLocalStorage } from 'node:async_hooks'

import mongoose, { type ClientSession } from 'mongoose'

const ambient = new AsyncLocalStorage<ClientSession>()

/**
 * Runs a service's writes atomically. Pass the session to every write, including the audit entry.
 * Called inside another transaction, it joins that one, so several services can form one atomic step.
 * The driver may run `work` again after a write conflict, so it must load what it changes itself.
 */
export async function inTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  const current = ambient.getStore()
  if (current) return work(current)
  const session = await mongoose.startSession()
  try {
    return await session.withTransaction(() => ambient.run(session, () => work(session)))
  } finally {
    await session.endSession()
  }
}
