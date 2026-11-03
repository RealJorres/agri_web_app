/** Text normalization shared by models, duplicate detection and imports. */

export function collapseSpaces(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/gu, ' ').trim()
}

/** Lowercase, strip accents and punctuation, collapse spaces. 'Sta. Niño ' -> 'sta nino'. */
export function normalizeName(value: string | null | undefined): string {
  const withoutAccents = (value ?? '').normalize('NFKD').replace(/\p{M}/gu, '')
  return collapseSpaces(withoutAccents.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' '))
}

/** Key for catalog codes and aliases: 'BR 25', 'br25 ' -> 'BR25'; 'DA- RFO' -> 'DARFO'. */
export function normalizeCode(value: string | null | undefined): string {
  return normalizeName(value).replaceAll(' ', '').toUpperCase()
}

// Only leading honorifics and a trailing suffix are dropped, so a middle initial is kept.
const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'dr', 'engr', 'atty', 'hon', 'kgd', 'capt', 'gng'])
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv'])
const EXPANSIONS = new Map([
  ['ma', 'maria'],
  ['sto', 'santo'],
  ['sta', 'santa'],
])

/** 'Ma. Luisa Reyes Jr.' -> 'maria luisa reyes'; 'Engr. Juan V. Cruz' -> 'juan v cruz'. */
export function normalizePersonName(value: string | null | undefined): string {
  const tokens = normalizeName(value).split(' ').filter(Boolean)
  while (tokens[0] !== undefined && HONORIFICS.has(tokens[0])) tokens.shift()
  const last = tokens.at(-1)
  if (tokens.length > 1 && last !== undefined && SUFFIXES.has(last)) tokens.pop()
  return tokens.map((token) => EXPANSIONS.get(token) ?? token).join(' ')
}
