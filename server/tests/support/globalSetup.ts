import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string
  }
}

/** One in-memory replica set per run: a replica set because services rely on transactions. */
export default async function globalSetup(project: TestProject): Promise<() => Promise<void>> {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  project.provide('mongoUri', replSet.getUri())
  return async () => {
    await replSet.stop()
  }
}
