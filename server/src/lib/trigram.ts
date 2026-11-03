/**
 * The same trigram similarity as PostgreSQL's pg_trgm (ADR-0007, ADR-0019): each word is padded with
 * two spaces in front and one behind, and similarity is shared trigrams over all distinct trigrams.
 */
export function trigrams(text: string): Set<string> {
  const grams = new Set<string>()
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue
    const letters = Array.from(`  ${word} `)
    for (let i = 0; i + 3 <= letters.length; i += 1) {
      grams.add(letters.slice(i, i + 3).join(''))
    }
  }
  return grams
}

export function similarity(a: string, b: string): number {
  const left = trigrams(a)
  const right = trigrams(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const gram of left) if (right.has(gram)) shared += 1
  return shared / (left.size + right.size - shared)
}
