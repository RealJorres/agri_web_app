import { fileURLToPath } from 'node:url'

import { z } from 'zod'

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8000),
    MONGODB_URI: z
      .string({ error: 'is required: add it to .env (see .env.example)' })
      .regex(/^mongodb(\+srv)?:\/\//, 'must start with mongodb:// or mongodb+srv://'),
    MONGODB_DB: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/, 'may only contain letters, digits, _ and -')
      .optional(),
  })
  .superRefine((value, context) => {
    // Development and production must never share a database by accident (ADR-0019).
    if (value.NODE_ENV === 'production' && !value.MONGODB_DB) {
      context.addIssue({
        code: 'custom',
        path: ['MONGODB_DB'],
        message: 'is required in production',
      })
    }
  })
  .transform((value) => ({ ...value, MONGODB_DB: value.MONGODB_DB ?? 'agri_dev' }))

export type Env = z.infer<typeof schema>

/** Raised when settings are missing or invalid. The message names settings, never their values. */
export class EnvError extends Error {
  constructor(problems: string[]) {
    super(`Invalid settings:\n${problems.map((problem) => `  ${problem}`).join('\n')}`)
    this.name = 'EnvError'
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source)
  if (result.success) return result.data
  throw new EnvError(
    result.error.issues.map((issue) => `${issue.path.map(String).join('.')} ${issue.message}`),
  )
}

/** True under the test runner, whatever NODE_ENV the surrounding shell happens to set. */
export function isTestRuntime(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.VITEST !== undefined
}

/**
 * Reads the repo-root .env, then validates. Variables already set take precedence over the file.
 * Tests never read .env, so they can never pick up the real connection string.
 */
export function loadEnv(): Env {
  if (!isTestRuntime()) {
    try {
      process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return parseEnv(process.env)
}
