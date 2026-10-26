/** Quote a CSV cell (RFC 4180) and neutralise spreadsheet formula injection. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  let text = String(value)
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function toCsv(columns: string[], rows: (string | number | null)[][]): string {
  return [columns, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')
}

export function downloadCsv(
  filename: string,
  columns: string[],
  rows: (string | number | null)[][],
): void {
  // BOM so Excel opens UTF-8 (Ñ, en dashes) correctly.
  const blob = new Blob(['﻿', toCsv(columns, rows)], { type: 'text/csv;charset=utf-8' })
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = filename
  link.click()
  URL.revokeObjectURL(href)
}
