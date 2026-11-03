import type { FieldValues, Path, UseFormSetError } from 'react-hook-form'

import { ApiError } from '@/lib/api/client'

/** Copy server field errors onto the form; returns the message for errors without a field. */
export function applyServerErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  known: readonly string[],
): string | null {
  if (!(error instanceof ApiError)) return 'Something went wrong. Please try again.'
  let unplaced = false
  for (const [field, messages] of Object.entries(error.fields)) {
    const name = field.split('.')[0] ?? field
    if (known.includes(name)) {
      setError(name as Path<T>, { type: 'server', message: messages.join(' ') })
    } else {
      unplaced = true
    }
  }
  return unplaced || Object.keys(error.fields).length === 0 ? error.message : null
}

const WAKING_UP = 'The server is waking up. Please wait a minute and try again.'

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    // A sleeping free-tier server takes about a minute to wake (ADR-0023).
    if (error.status >= 502 && error.status <= 504) return WAKING_UP
    // A field's message can repeat the main one, and should not then be shown twice.
    const details = Object.values(error.fields)
      .flat()
      .filter((detail) => detail !== error.message)
    return details.length ? `${error.message} ${details.join(' ')}` : error.message
  }
  return 'Something went wrong. Please try again.'
}
