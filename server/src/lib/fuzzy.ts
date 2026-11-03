/** Fuzzy name comparison, with the same result as rapidfuzz's token_sort_ratio. */

function longestCommonSubsequence(a: string[], b: string[]): number {
  let previous = new Array<number>(b.length + 1).fill(0)
  for (const letter of a) {
    const current = [0]
    for (let j = 1; j <= b.length; j += 1) {
      current[j] =
        letter === b[j - 1]
          ? (previous[j - 1] ?? 0) + 1
          : Math.max(previous[j] ?? 0, current[j - 1] ?? 0)
    }
    previous = current
  }
  return previous[b.length] ?? 0
}

/** 100 for equal text, falling with each letter that would need inserting or deleting. */
export function ratio(a: string, b: string): number {
  const left = Array.from(a)
  const right = Array.from(b)
  if (left.length === 0 && right.length === 0) return 100
  return (200 * longestCommonSubsequence(left, right)) / (left.length + right.length)
}

function sortedTokens(text: string): string {
  return text.split(/\s+/u).filter(Boolean).sort().join(' ')
}

/** Like ratio, but word order does not matter. */
export function tokenSortRatio(a: string, b: string): number {
  return ratio(sortedTokens(a), sortedTokens(b))
}
