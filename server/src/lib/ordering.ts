/** The `ordering` query parameter for small reference lists that are returned whole. */

export type SortValue = string | number | boolean | null

export type SortFields<Row> = Record<string, (row: Row) => SortValue>

const collator = new Intl.Collator('en')

function compareValues(a: SortValue, b: SortValue): number {
  if (typeof a === 'string' && typeof b === 'string') return collator.compare(a, b)
  return Number(a) - Number(b)
}

function compare(a: SortValue, b: SortValue, descending: boolean): number {
  // Empty values sort last going up and first going down, as they did in PostgreSQL.
  if (a === null || b === null) {
    if (a === b) return 0
    return (a === null ? 1 : -1) * (descending ? -1 : 1)
  }
  return compareValues(a, b) * (descending ? -1 : 1)
}

/**
 * Sorts by a comma-separated list such as 'name,-code'. Unknown names are ignored, and when none
 * remain the default order applies.
 */
export function orderRows<Row>(
  rows: readonly Row[],
  requested: unknown,
  fields: SortFields<Row>,
  defaults: readonly string[],
): Row[] {
  const terms = typeof requested === 'string' ? requested.split(',').map((term) => term.trim()) : []
  const known = terms.filter((term) => Object.hasOwn(fields, term.replace(/^-/, '')))
  const keys = (known.length > 0 ? known : defaults).map((term) => {
    const name = term.replace(/^-/, '')
    return { value: fields[name] as (row: Row) => SortValue, descending: term.startsWith('-') }
  })
  return [...rows].sort((a, b) => {
    for (const { value, descending } of keys) {
      const order = compare(value(a), value(b), descending)
      if (order !== 0) return order
    }
    return 0
  })
}
