/** Reading spreadsheet cells as plain values. */
import type { CellValue } from 'exceljs'

/** A cell's text. A formula gives its cached result; this never recalculates anything. */
export function cellText(value: CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== 'object') return String(value).trim()
  if ('richText' in value)
    return value.richText
      .map((part) => part.text)
      .join('')
      .trim()
  if ('error' in value) return ''
  if ('formula' in value || 'sharedFormula' in value) return cellText(value.result)
  if ('text' in value)
    return typeof value.text === 'string' ? value.text.trim() : cellText(value.text)
  return ''
}
