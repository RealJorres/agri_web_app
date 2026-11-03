import mongoose, { type ClientSession } from 'mongoose'

/** Runs a service's writes atomically. Pass the session to every write, including the audit entry. */
export async function inTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession()
  try {
    return await session.withTransaction(() => work(session))
  } finally {
    await session.endSession()
  }
}
