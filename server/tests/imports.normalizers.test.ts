/** One test per messy example in brief §3, plus close variants. Pure functions, no database. */
import { describe, expect, it } from 'vitest'

import { ratio, tokenSortRatio } from '../src/lib/fuzzy.js'
import {
  cleanBarangay,
  cleanText,
  mapTokens,
  parseAssociations,
  parseContact,
  parseCount,
  parsePersonName,
  parseRemarks,
  parseYears,
  splitSites,
  splitValues,
} from '../src/services/imports/normalizers.js'

describe('cleanText', () => {
  it.each([
    [null, ''],
    ['  BR25 ', 'BR25'],
    [2016, '2016'],
    [9171234567, '9171234567'],
    [1.5, '1.5'],
  ])('%j -> %j', (raw, expected) => {
    expect(cleanText(raw)).toBe(expected)
  })
})

describe('parseYears', () => {
  it.each<[unknown, number[]]>([
    [2016, [2016]],
    ['2016', [2016]],
    ['2016, 2018,2021 & 2022', [2016, 2018, 2021, 2022]],
    ['2017& 2019', [2017, 2019]],
    ['2017 and 2019', [2017, 2019]],
    ['2015/2016', [2015, 2016]],
    ['May 2015', [2015]],
    ['2018, 2018', [2018]],
    [new Date(Date.UTC(2019, 5, 1)), [2019]],
    [42736, [2017]], // the Excel serial for 2017-01-01
    [null, []],
    ['  ', []],
  ])('parses %j', (raw, years) => {
    expect(parseYears(raw)).toEqual({ years, issue: '' })
  })

  it.each<[unknown]>([['unknown'], ['June'], [2016.5], [123], ['1899']])('reports %j', (raw) => {
    const result = parseYears(raw)
    expect(result.years).toEqual([])
    expect(result.issue).toBeTruthy()
  })
})

describe('parseCount', () => {
  it.each<[unknown, number | null]>([
    [25, 25],
    ['1,200', 1200],
    [' 40 ', 40],
    [0, 0],
    [null, null],
    ['-', null],
    ['', null],
    [10_500, 10_500],
  ])('parses %j', (raw, value) => {
    expect(parseCount(raw)).toEqual({ value, issue: '' })
  })

  it.each<[unknown]>([['about 50'], [12.5], [-3], [true], ['Infinity'], ['NaN']])(
    'rejects %j',
    (raw) => {
      const result = parseCount(raw)
      expect(result.value).toBeNull()
      expect(result.issue).toBeTruthy()
    },
  )
})

describe('splitValues', () => {
  it.each<[unknown, string[]]>([
    ['UF18 & BR25', ['UF18', 'BR25']],
    ['BR25&UF18', ['BR25', 'UF18']],
    ['BR 25', ['BR 25']],
    ['BR25 ', ['BR25']],
    ['CriolIo', ['CriolIo']],
    ['KI & K18', ['KI', 'K18']],
    ['W10 &  Criollo', ['W10', 'Criollo']],
    ['DA-RFO', ['DA-RFO']],
    ['DA- RFO', ['DA- RFO']],
    ['DA/PCA/Own Produced', ['DA', 'PCA', 'Own Produced']],
    ['Own Produce', ['Own Produce']],
    ['BR25 and UF18', ['BR25', 'UF18']],
    [null, []],
  ])('%j -> %j', (raw, tokens) => {
    expect(splitValues(raw)).toEqual(tokens)
  })
})

describe('mapTokens', () => {
  it('keeps unknown tokens for review, and counts each row once', () => {
    const index = new Map([
      ['BR25', 'br25-row'],
      ['K1', 'k1-row'],
    ])
    expect(mapTokens(['BR25', 'K18', 'K1', 'BR25'], (token) => index.get(token))).toEqual({
      found: ['br25-row', 'k1-row'],
      unknown: ['K18'],
    })
  })
})

describe('places', () => {
  it.each([
    ['Lamesa, Mogpog', 'Mogpog', 'Lamesa'],
    ['Lamesa,Mogpog', 'MOGPOG', 'Lamesa'],
    ['Brgy. Lamesa', 'Mogpog', 'Lamesa'],
    ['Lamesa, Mogpog, Marinduque', 'Mogpog', 'Lamesa'],
    ['Sta. Cruz Poblacion', 'Santa Cruz', 'Sta. Cruz Poblacion'],
    ['Lamesa, Boac', 'Mogpog', 'Lamesa, Boac'], // another town: kept for review
  ])('cleans %j in %s', (raw, town, expected) => {
    expect(cleanBarangay(raw, town)).toBe(expected)
  })

  it('splits sites', () => {
    expect(splitSites('Pulong Parang/Masalukot', 'Gasan')).toEqual(['Pulong Parang', 'Masalukot'])
    expect(splitSites('Masalukot, Gasan', 'Gasan')).toEqual(['Masalukot'])
    expect(splitSites('', 'Gasan')).toEqual([])
  })
})

describe('parsePersonName', () => {
  const name = (first: string, middle = '', last = '', suffix = '') => ({
    first,
    middle,
    last,
    suffix,
  })

  it.each([
    ['Juan Sample', name('Juan', '', 'Sample')],
    ['Juan A. Dela Cruz Jr.', name('Juan', 'A.', 'Dela Cruz', 'Jr.')],
    ['Ma. Luisa Reyes', name('Ma. Luisa', '', 'Reyes')],
    ['Dela Cruz, Juan A.', name('Juan', 'A.', 'Dela Cruz')],
    ['Santos, Maria Clara Jr.', name('Maria Clara', '', 'Santos', 'Jr.')],
    ['Jose De los Santos', name('Jose', '', 'De los Santos')],
    ['Engr. Pedro Sample III', name('Pedro', '', 'Sample', 'III')],
    ['Sample', name('', '', 'Sample')],
    ['  ', name('')],
  ])('%j', (raw, parts) => {
    expect(parsePersonName(raw)).toEqual(parts)
  })
})

describe('parseContact', () => {
  it.each<[unknown, string]>([
    [9171234567, '09171234567'],
    ['0917-123-4567', '09171234567'],
    ['+63 917 123 4567', '09171234567'],
    ['09171234567 / 09281234567', '09171234567; 09281234567'],
    [null, ''],
  ])('%j -> %j', (raw, expected) => {
    expect(parseContact(raw)).toBe(expected)
  })
})

describe('parseAssociations', () => {
  it.each<[unknown, string[]]>([
    ['None Member', []],
    ['none', []],
    ['', []],
    [null, []],
    ['Mat. Gasan FA', ['Mat. Gasan FA']],
    ['Tambangan FA, SAGANA', ['Tambangan FA', 'SAGANA']],
    ['Sample FA; Other Coop', ['Sample FA', 'Other Coop']],
  ])('%j -> %j', (raw, names) => {
    expect(parseAssociations(raw)).toEqual(names)
  })
})

describe('parseRemarks', () => {
  it.each([
    ['8 kilos harvest', '8', 'kg', 'unknown', false],
    ['3 kls.', '3', 'kg', 'unknown', false],
    ['1 sack', '1', 'sack', 'unknown', false],
    ['6 kilos dried', '6', 'kg', 'dried_beans', false],
    ['1 kilo every other month', '1', 'kg', 'unknown', true],
    ['2.5 kg', '2.5', 'kg', 'unknown', false],
  ])('%j is a harvest', (raw, quantity, unit, productForm, recurring) => {
    const { harvests, remaining } = parseRemarks(raw)
    expect(harvests).toHaveLength(1)
    expect(harvests[0]).toMatchObject({ quantity, unit, productForm, recurring })
    expect(harvests[0]?.rawText).toBeTruthy()
    expect(remaining).toBe('')
  })

  it('leaves tree losses in the remarks', () => {
    const raw = '325 trees died in May 2023, 80 now'
    expect(parseRemarks(raw)).toEqual({ harvests: [], remaining: raw })
  })

  it('keeps the rest of a mixed remark', () => {
    const result = parseRemarks('8 kilos harvest; needs rehabilitation')
    expect(result.harvests.map((harvest) => harvest.quantity)).toEqual(['8'])
    expect(result.remaining).toBe('needs rehabilitation')
  })

  it('handles an empty cell, and a comma as the decimal point', () => {
    expect(parseRemarks(null).harvests).toEqual([])
    expect(parseRemarks('2,5 kg').harvests[0]?.quantity).toBe('2.5')
  })
})

describe('fuzzy matching', () => {
  it('matches the values rapidfuzz documents', () => {
    expect(ratio('this is a test', 'this is a test!')).toBeCloseTo(96.55, 2)
    expect(tokenSortRatio('fuzzy wuzzy was a bear', 'wuzzy fuzzy was a bear')).toBe(100)
  })

  it('is 100 for two empty strings and 0 with nothing shared', () => {
    expect(ratio('', '')).toBe(100)
    expect(ratio('abc', 'xyz')).toBe(0)
  })
})
