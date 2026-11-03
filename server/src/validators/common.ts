import { z } from 'zod'

type Camel<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<Camel<Tail>>}`
  : S

export type CamelKeys<T> = { [K in keyof T as Camel<K & string>]: T[K] }

/** API bodies use snake_case and services use camelCase. Keys with no value are left out. */
export function camelKeys<T extends object>(source: T): CamelKeys<T> {
  const entries = Object.entries(source as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [
      key.replace(/_(\w)/gu, (_, letter: string) => letter.toUpperCase()),
      value,
    ])
  return Object.fromEntries(entries) as CamelKeys<T>
}

export const id = z.guid('Must be a valid UUID.')

// A filter left empty means no filter, so ?municipality= behaves like leaving it out.
const emptyAsMissing = (value: unknown) => (value === '' ? undefined : value)

export const filterId = z.preprocess(emptyAsMissing, id.optional())

export function filterChoice<const T extends readonly [string, ...string[]]>(choices: T) {
  return z.preprocess(emptyAsMissing, z.enum(choices).optional())
}

export function text(max?: number) {
  const trimmed = z.string().trim()
  return max === undefined ? trimmed : trimmed.max(max, `At most ${String(max)} characters.`)
}

/** A whole number, from JSON or from a form's numeric string. */
export function integer(min: number, max: number) {
  return z.preprocess(
    (value) => (typeof value === 'string' && /^-?\d+$/u.test(value) ? Number(value) : value),
    z.number().int().min(min).max(max),
  )
}

/** An exact decimal, returned as a string so it never passes through a float. */
export function decimal({ maxDigits, places }: { maxDigits: number; places: number }) {
  return z
    .union([z.string(), z.number()])
    .transform((value) => String(value).trim())
    .superRefine((value, context) => {
      const match = /^(\d+)(?:\.(\d+))?$/u.exec(value)
      if (!match) {
        context.addIssue({ code: 'custom', message: 'Enter a number that is not negative.' })
        return
      }
      const whole = (match[1] ?? '').replace(/^0+/u, '')
      if ((match[2] ?? '').length > places) {
        context.addIssue({ code: 'custom', message: `At most ${String(places)} decimal places.` })
      }
      if (whole.length > maxDigits - places) {
        context.addIssue({ code: 'custom', message: 'This number is too large.' })
      }
    })
}

export const isoDate = z.iso.date('Enter a date as YYYY-MM-DD.')
