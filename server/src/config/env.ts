import { fileURLToPath } from 'node:url'

import { z } from 'zod'

const MIN_SIGNING_KEY_LENGTH = 50
// Production refuses to start with this value, so it can only ever sign development sessions.
const DEV_SIGNING_KEY = 'dev-only-insecure-signing-key-0123456789abcdef0123456789'

/** The key for signing tokens. In production, parseEnv has already proved the variable is sound. */
export function jwtSigningKey(): Uint8Array {
  return new TextEncoder().encode(process.env.JWT_SIGNING_KEY ?? DEV_SIGNING_KEY)
}

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
    JWT_SIGNING_KEY: z.string().optional(),
    TRUSTED_PROXY_COUNT: z.coerce.number().int().min(0).default(0),
    CSRF_TRUSTED_ORIGINS: z.string().default(''),
    PUBLIC_ORIGIN: z
      .string()
      .regex(/^https:\/\/[^/\s]+$/, 'must look like https://agri.example.gov.ph, with no path')
      .optional(),
    STATIC_DIR: z.string().min(1).optional(),
    PRIVATE_FILES_DIR: z.string().min(1).optional(),
    MAP_TILE_URL: z.string().min(1).optional(),
    MAP_TILE_ATTRIBUTION: z.string().optional(),
    MAP_DEFAULT_CENTER: z.string().optional(),
    MAP_DEFAULT_ZOOM: z.coerce.number().optional(),
    IMPORT_FILE_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV !== 'production') return
    // Development and production must never share a database by accident (ADR-0019).
    if (!value.MONGODB_DB) {
      context.addIssue({
        code: 'custom',
        path: ['MONGODB_DB'],
        message: 'is required in production',
      })
    }
    if (!value.PUBLIC_ORIGIN) {
      context.addIssue({
        code: 'custom',
        path: ['PUBLIC_ORIGIN'],
        message: 'is required in production',
      })
    }
    // This server does not end TLS itself, so with no proxy every request would look like plain HTTP.
    if (value.TRUSTED_PROXY_COUNT < 1) {
      context.addIssue({
        code: 'custom',
        path: ['TRUSTED_PROXY_COUNT'],
        message: 'must be at least 1 in production, for the proxy that ends HTTPS',
      })
    }
    const key = value.JWT_SIGNING_KEY ?? ''
    if (key.length < MIN_SIGNING_KEY_LENGTH || key.includes('insecure')) {
      context.addIssue({
        code: 'custom',
        path: ['JWT_SIGNING_KEY'],
        message: `must be a random value of at least ${MIN_SIGNING_KEY_LENGTH} characters in production`,
      })
    }
  })
  .transform((value) => ({
    ...value,
    MONGODB_DB: value.MONGODB_DB ?? 'agri_dev',
    CSRF_TRUSTED_ORIGINS: value.CSRF_TRUSTED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  }))

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
