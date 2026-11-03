import { describe, expect, it } from 'vitest'
import type { CellValue } from 'exceljs'

import { cellText } from '../src/lib/workbook.js'

describe('cellText', () => {
  it.each<[string, unknown, string]>([
    ['empty', null, ''],
    ['missing', undefined, ''],
    ['text, trimmed', '  Sample ', 'Sample'],
    ['a number', 9904001000, '9904001000'],
    ['a boolean', true, 'true'],
    ['a date', new Date('2023-07-01T00:00:00Z'), '2023-07-01T00:00:00.000Z'],
    ['rich text', { richText: [{ text: 'Sam' }, { text: 'ple ' }] }, 'Sample'],
    ['a formula, by its cached result', { formula: 'SUM(A1:A2)', result: 940 }, '940'],
    ['a shared formula', { sharedFormula: 'A1', result: 'Sample' }, 'Sample'],
    ['a formula with no cached result', { formula: 'SUM(A1:A2)' }, ''],
    ['a formula that cached an error', { formula: '1/0', result: { error: '#DIV/0!' } }, ''],
    ['an error', { error: '#REF!' }, ''],
    ['a hyperlink', { text: ' Sample ', hyperlink: 'https://example.test' }, 'Sample'],
    [
      'a hyperlink over rich text',
      { text: { richText: [{ text: 'Sample' }] }, hyperlink: 'https://example.test' },
      'Sample',
    ],
    ['an unknown object', { other: 1 }, ''],
  ])('reads %s', (_name, value, expected) => {
    expect(cellText(value as CellValue)).toBe(expected)
  })
})
