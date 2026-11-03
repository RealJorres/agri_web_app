/**
 * The only place the server writes logs. Callers pass an event name and non-personal details:
 * ids and counts, never names, contact numbers, request bodies or query strings (RA 10173).
 */
type Details = Record<string, string | number | boolean | undefined>

function write(level: 'info' | 'warn' | 'error', event: string, details: Details): void {
  if (process.env.NODE_ENV === 'test') return
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...details })
  if (level === 'info') console.log(line)
  else console.error(line)
}

export const logger = {
  info: (event: string, details: Details = {}) => {
    write('info', event, details)
  },
  warn: (event: string, details: Details = {}) => {
    write('warn', event, details)
  },
  error: (event: string, details: Details = {}) => {
    write('error', event, details)
  },
}

/**
 * Error details that are safe to log. Messages are left out because database errors can quote the
 * values that caused them, such as a farmer's name in a duplicate-key error.
 */
export function safeErrorDetails(error: unknown): Details {
  if (!(error instanceof Error)) return { errorName: 'unknown' }
  const code = (error as { code?: unknown }).code
  const frames = error.stack
    ?.split('\n')
    .filter((line) => line.trimStart().startsWith('at '))
    .slice(0, 8)
    .map((line) => line.trim())
    .join(' | ')
  return {
    errorName: error.name,
    errorCode: typeof code === 'string' || typeof code === 'number' ? code : undefined,
    frames,
  }
}
