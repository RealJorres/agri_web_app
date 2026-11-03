import { describe, expect, it } from 'vitest'

import { similarity, trigrams } from '../src/lib/trigram.js'
import { normalizePersonName } from '../src/lib/text.js'

describe('trigrams', () => {
  it('pads words the way pg_trgm does', () => {
    expect([...trigrams('cat')].sort()).toEqual(['  c', ' ca', 'at ', 'cat'].sort())
  })

  it('splits on anything that is not a letter or digit, and ignores case', () => {
    expect(trigrams('A-b')).toEqual(trigrams('a b'))
  })

  it('counts a repeated trigram once', () => {
    expect(trigrams('aaaa').size).toBe(4)
  })

  it('treats accented letters as single characters', () => {
    expect([...trigrams('ñ')].sort()).toEqual(['  ñ', ' ñ '].sort())
  })
})

describe('similarity', () => {
  it('matches the value pg_trgm gives for its documented example', () => {
    expect(similarity('word', 'two words')).toBeCloseTo(0.363636, 5)
  })

  it('is 1 for equal text and 0 with nothing shared or nothing at all', () => {
    expect(similarity('sample name', 'sample name')).toBe(1)
    expect(similarity('abc', 'xyz')).toBe(0)
    expect(similarity('', 'abc')).toBe(0)
  })
})

describe('normalizePersonName', () => {
  it.each([
    ['Ma. Luisa Reyes', 'maria luisa reyes'],
    ['Maria Luisa Reyes Jr.', 'maria luisa reyes'],
    ['Engr. Juan V. Cruz', 'juan v cruz'],
    ['Sto. Tomas', 'santo tomas'],
    ['JR', 'jr'], // a lone token is never dropped
    ['', ''],
  ])('%j -> %j', (raw, expected) => {
    expect(normalizePersonName(raw)).toBe(expected)
  })
})
