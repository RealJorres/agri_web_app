/**
 * Creates a superuser: npm run create-admin -w server -- admin@example.gov.ph
 * The password is typed at a hidden prompt, so it never reaches shell history or a process list.
 */
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'

import { connectDatabase, disconnectDatabase } from '../src/config/database.js'
import { loadEnv } from '../src/config/env.js'
import { DomainError } from '../src/lib/errors.js'
import { createUser } from '../src/services/accounts.service.js'

async function askHidden(question: string): Promise<string> {
  process.stdout.write(question)
  const silent = new Writable({
    write(_chunk, _encoding, done) {
      done()
    },
  })
  const prompt = createInterface({ input: process.stdin, output: silent, terminal: true })
  const answer = await prompt.question('')
  prompt.close()
  process.stdout.write('\n')
  return answer
}

const email = process.argv[2]
if (!email) {
  console.error('Usage: npm run create-admin -w server -- <email>')
  process.exit(1)
}

const env = loadEnv()
const password = await askHidden('Password: ')
if (password !== (await askHidden('Password again: '))) {
  console.error('The passwords do not match.')
  process.exit(1)
}

await connectDatabase(env.MONGODB_URI, env.MONGODB_DB, { autoIndex: env.NODE_ENV !== 'production' })
try {
  await createUser({ email, password, isSuperuser: true, actorId: null })
  console.log(`Admin account created in database ${env.MONGODB_DB}.`)
} catch (error) {
  if (!(error instanceof DomainError)) throw error
  console.error([error.message, ...Object.values(error.fields).flat()].join('\n'))
  process.exitCode = 1
} finally {
  await disconnectDatabase()
}
