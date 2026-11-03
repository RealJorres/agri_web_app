/**
 * Pure normalizers for messy spreadsheet cells (brief §3), with no database access. Every function is
 * total: it never throws on bad input, and returns a value plus any issue, so the pipeline can show
 * problems on the preview screen.
 */
import { Decimal } from 'decimal.js'

import { collapseSpaces, normalizeName } from '../../lib/text.js'

export function cleanText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace('T', ' ')
  if (typeof value === 'string') return collapseSpaces(value)
  if (typeof value === 'number' || typeof value === 'boolean') return collapseSpaces(String(value))
  return ''
}

const SPLIT = /\s*(?:,|&|\/|\+|;|\band\b)\s*/iu

/**
 * 'UF18 & BR25', 'BR25&UF18', 'DA/PCA/Own Produced' -> tokens. A hyphen does not separate, so
 * 'DA-RFO' and 'DA- RFO' stay whole.
 */
export function splitValues(raw: unknown): string[] {
  const text = cleanText(raw)
  return text ? text.split(SPLIT).map(collapseSpaces).filter(Boolean) : []
}

// --- Years planted

const YEAR_MIN = 1950
const YEAR_MAX = 2030
const YEAR = /(?<!\d)(19\d{2}|20\d{2})(?!\d)/gu
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)
const DAY_MS = 86_400_000

export interface YearsResult {
  years: number[]
  /** Empty when the cell parsed cleanly. */
  issue: string
}

function checkedYears(years: number[]): YearsResult {
  const inRange = (year: number) => year >= YEAR_MIN && year <= YEAR_MAX
  const bad = years.filter((year) => !inRange(year))
  return {
    years: years.filter(inRange),
    issue: bad.length > 0 ? `year out of range: [${bad.join(', ')}]` : '',
  }
}

/**
 * A DATE PLANTED cell -> planting years. 2016 -> [2016]; an Excel date serial -> its year; a date ->
 * its year; text -> every 4-digit year in order, without repeats.
 */
export function parseYears(value: unknown): YearsResult {
  if (value === null || value === undefined) return { years: [], issue: '' }
  if (typeof value === 'string' && !value.trim()) return { years: [], issue: '' }
  if (value instanceof Date) return checkedYears([value.getUTCFullYear()])
  if (typeof value === 'number' || typeof value === 'boolean') {
    const number = Number(value)
    if (!Number.isInteger(number)) return { years: [], issue: `not a year: ${String(value)}` }
    if (number >= YEAR_MIN && number <= YEAR_MAX) return { years: [number], issue: '' }
    if (number > 10_000 && number < 80_000) {
      return checkedYears([new Date(EXCEL_EPOCH_MS + number * DAY_MS).getUTCFullYear()])
    }
    return { years: [], issue: `not a year: ${String(number)}` }
  }
  const text = cleanText(value)
  const found = [...new Set(Array.from(text.matchAll(YEAR), (match) => Number(match[1])))]
  if (found.length === 0) return { years: [], issue: `no year found in '${text}'` }
  return checkedYears(found)
}

// --- Counts

export interface CountResult {
  value: number | null
  issue: string
}

const EMPTY_MARKERS = new Set(['', '-', '--', 'n/a', 'na', 'none'])

/** A stage cell -> a whole number of 0 or more. '1,200' -> 1200; '-' or blank -> null. */
export function parseCount(value: unknown): CountResult {
  if (value === null || value === undefined) return { value: null, issue: '' }
  if (typeof value === 'boolean') return { value: null, issue: `not a number: ${String(value)}` }
  let number: Decimal
  if (typeof value === 'number') {
    number = new Decimal(value)
  } else {
    const text = cleanText(value).replaceAll(',', '')
    if (EMPTY_MARKERS.has(text.toLowerCase())) return { value: null, issue: '' }
    try {
      number = new Decimal(text)
    } catch {
      return { value: null, issue: `not a number: '${cleanText(value)}'` }
    }
    if (!number.isFinite()) return { value: null, issue: `not a number: '${cleanText(value)}'` }
  }
  if (number.isNegative() && !number.isZero()) {
    return { value: null, issue: `negative: ${number.toFixed()}` }
  }
  if (!number.isInteger()) return { value: null, issue: `not a whole number: ${number.toFixed()}` }
  return { value: number.toNumber(), issue: '' }
}

// --- Places

const BARANGAY_PREFIX = /^(?:brgy|bgy|barangay|bo)\.?\s+/iu

/** 'Lamesa, Mogpog' -> 'Lamesa'; 'Brgy. Lamesa' -> 'Lamesa'. Other text is kept as it is. */
export function cleanBarangay(raw: unknown, municipality: string): string {
  const text = cleanText(raw).replace(BARANGAY_PREFIX, '')
  const town = normalizeName(municipality)
  const parts = text.split(',').map((part) => part.trim())
  while (parts.length > 1) {
    const last = normalizeName(parts.at(-1))
    if (last !== town && last !== 'marinduque') break
    parts.pop()
  }
  return collapseSpaces(parts.join(', '))
}

/** FARM LOCATION -> candidate barangay names: 'Pulong Parang/Masalukot' -> both. */
export function splitSites(raw: unknown, municipality: string): string[] {
  return cleanBarangay(raw, municipality)
    .split(/\s*\/\s*|\s*&\s*/u)
    .filter((part) => part.trim())
    .map((part) => cleanBarangay(part, municipality))
}

// --- People

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv'])
const SURNAME_PARTICLES = new Set([
  'de',
  'dela',
  'del',
  'delos',
  'los',
  'la',
  'san',
  'sta',
  'sto',
  'di',
  'y',
])
const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'dr', 'engr', 'atty', 'hon', 'kgd', 'capt'])

export interface NameParts {
  first: string
  middle: string
  last: string
  suffix: string
}

const isInitial = (token: string) => /^[A-Za-z]\.?$/u.test(token)
const normToken = (token: string) => token.toLowerCase().replace(/[.,]+$/u, '')

/**
 * A best-effort split of a Filipino full name. The raw text is always kept separately.
 * 'Dela Cruz, Juan A.' -> Juan, A., Dela Cruz; 'Juan A. Dela Cruz Jr.' -> Juan, A., Dela Cruz, Jr.
 */
export function parsePersonName(raw: unknown): NameParts {
  const text = cleanText(raw)
  if (!text) return { first: '', middle: '', last: '', suffix: '' }
  const comma = text.indexOf(',')
  if (comma >= 0) {
    const tokens = text
      .slice(comma + 1)
      .split(' ')
      .filter(Boolean)
    let suffix = ''
    const tail = tokens.at(-1)
    if (tail !== undefined && SUFFIXES.has(normToken(tail))) suffix = tokens.pop() ?? ''
    const initial = tokens.at(-1)
    const middle = tokens.length > 1 && initial !== undefined && isInitial(initial) ? initial : ''
    if (middle) tokens.pop()
    return { first: tokens.join(' '), middle, last: collapseSpaces(text.slice(0, comma)), suffix }
  }

  const tokens = text.split(' ').filter(Boolean)
  while (tokens.length > 1 && HONORIFICS.has(normToken(tokens[0] ?? ''))) tokens.shift()
  const tail = tokens.at(-1) ?? ''
  const suffix = tokens.length > 1 && SUFFIXES.has(normToken(tail)) ? tail : ''
  if (suffix) tokens.pop()
  if (tokens.length === 1) return { first: '', middle: '', last: tokens[0] ?? '', suffix }
  // The surname is the last token, plus any particles before it ("Dela Cruz", "De los Santos").
  let start = tokens.length - 1
  while (start > 1 && SURNAME_PARTICLES.has(normToken(tokens[start - 1] ?? ''))) start -= 1
  const given = tokens.slice(0, start)
  const initial = given.at(-1)
  const middle = given.length > 1 && initial !== undefined && isInitial(initial) ? initial : ''
  if (middle) given.pop()
  return { first: given.join(' '), middle, last: tokens.slice(start).join(' '), suffix }
}

/** '9171234567' (an Excel number) -> '09171234567'; several numbers are joined with '; '. */
export function parseContact(raw: unknown): string {
  const text = cleanText(raw)
  if (!text) return ''
  const numbers: string[] = []
  for (const part of text.split(/\s*(?:\/|;|,|&|\bor\b)\s*/u)) {
    let digits = part.replace(/\D/gu, '')
    if (digits.length === 10 && digits.startsWith('9')) digits = `0${digits}`
    if (digits.length === 12 && digits.startsWith('639')) digits = `0${digits.slice(2)}`
    if (digits) numbers.push(digits)
  }
  return numbers.join('; ')
}

// --- Associations

const NO_ASSOCIATION = [
  '',
  'none',
  'none member',
  'non member',
  'non-member',
  'not member',
  'n/a',
  'na',
  '-',
]
const NO_ASSOCIATION_RAW = new Set(NO_ASSOCIATION)
const NO_ASSOCIATION_NORMALIZED = new Set(NO_ASSOCIATION.map(normalizeName))

/** 'None Member' or blank -> []; 'Tambangan FA, SAGANA' -> two names. */
export function parseAssociations(raw: unknown): string[] {
  const text = cleanText(raw)
  if (NO_ASSOCIATION_NORMALIZED.has(normalizeName(text))) return []
  return text
    .split(/\s*[,;]\s*|\s+\/\s+/u)
    .map(collapseSpaces)
    .filter((name) => name && !NO_ASSOCIATION_RAW.has(normalizeName(name)))
}

// --- Remarks and harvests

export interface HarvestInfo {
  /** An exact decimal, as text. */
  quantity: string
  unit: 'kg' | 'sack'
  productForm: 'dried_beans' | 'unknown'
  rawText: string
  recurring: boolean
}

export interface RemarksResult {
  harvests: HarvestInfo[]
  remaining: string
}

const UNITS: Record<string, 'kg' | 'sack'> = {
  kg: 'kg',
  kgs: 'kg',
  kilo: 'kg',
  kilos: 'kg',
  kl: 'kg',
  kls: 'kg',
  sack: 'sack',
  sacks: 'sack',
  sako: 'sack',
}
const HARVEST = /(\d+(?:[.,]\d+)?)\s*(kilos?|kgs?|kls?|sacks?|sako)\b\.?(?<tail>[^,;]*)/giu
const RECURRING = /\bevery\b|\bper\s+(?:week|month|harvest)\b|\bmonthly\b/iu

/**
 * '8 kilos harvest', '3 kls.', '1 sack', '6 kilos dried', '1 kilo every other month' -> harvests.
 * Other text, such as tree losses, stays in `remaining`.
 */
export function parseRemarks(raw: unknown): RemarksResult {
  const text = cleanText(raw)
  if (!text) return { harvests: [], remaining: '' }
  const harvests: HarvestInfo[] = []
  let remaining = text
  const matches = Array.from(text.matchAll(HARVEST))
  for (const match of matches) {
    const phrase = match[0].trim()
    harvests.push({
      quantity: new Decimal((match[1] ?? '0').replace(',', '.')).toFixed(),
      unit: UNITS[(match[2] ?? '').toLowerCase()] ?? 'kg',
      productForm: /\bdried?\b/iu.test(phrase) ? 'dried_beans' : 'unknown',
      rawText: phrase,
      recurring: RECURRING.test(match.groups?.tail ?? ''),
    })
  }
  for (const match of [...matches].reverse()) {
    const start = match.index
    remaining = `${remaining.slice(0, start)} ${remaining.slice(start + match[0].length)}`
  }
  remaining = collapseSpaces(remaining.replace(/^[\s,;.]+|[\s,;]+$/gu, ''))
  if (['', 'harvest', 'harvested'].includes(normalizeName(remaining))) remaining = ''
  return { harvests, remaining }
}

// --- Catalog mapping

export interface Mapped<T> {
  found: T[]
  unknown: string[]
}

/** Resolves each token through the catalog, and keeps unknown tokens for review. */
export function mapTokens<T>(
  tokens: Iterable<string>,
  resolve: (token: string) => T | undefined,
): Mapped<T> {
  const found: T[] = []
  const unknown: string[] = []
  for (const token of tokens) {
    const row = resolve(token)
    if (row === undefined) unknown.push(token)
    else if (!found.includes(row)) found.push(row)
  }
  return { found, unknown }
}
