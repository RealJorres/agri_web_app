/** True when a write broke a unique index covering the given field. */
export function isDuplicateKey(error: unknown, field: string): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { code, keyPattern } = error as { code?: unknown; keyPattern?: unknown }
  return (
    code === 11000 && typeof keyPattern === 'object' && keyPattern !== null && field in keyPattern
  )
}
