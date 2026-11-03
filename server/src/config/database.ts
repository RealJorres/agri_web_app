import mongoose from 'mongoose'

import { isTestRuntime } from './env.js'

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Refuses anything but a local database. Error messages never repeat the URI: it holds a password. */
export function assertLocalDatabaseUri(uri: string): void {
  if (!uri.startsWith('mongodb://')) {
    throw new Error('Tests may only use a local database, and this URI is not one.')
  }
  const authority = uri.slice('mongodb://'.length).split(/[/?]/, 1)[0] ?? ''
  const hosts = (authority.split('@').pop() ?? '').split(',')
  const isLocal = hosts.every((host) => LOCAL_HOSTS.has(host.replace(/:\d+$/, '')))
  if (!isLocal) {
    throw new Error('Tests may only use a local database, and this URI is not one.')
  }
}

export async function connectDatabase(
  uri: string,
  dbName: string,
  { autoIndex }: { autoIndex: boolean },
): Promise<void> {
  if (isTestRuntime()) assertLocalDatabaseUri(uri)
  await mongoose.connect(uri, {
    dbName,
    autoIndex,
    autoCreate: autoIndex,
    // Fail at once while disconnected, rather than queueing writes that may run much later.
    bufferCommands: false,
    serverSelectionTimeoutMS: 5000,
  })
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect()
}
