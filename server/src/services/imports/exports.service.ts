/**
 * Excel exports of farmer and inventory lists, with the caller's current filters. Both hold personal
 * data: they need the export capability, and every export is audited with the filters used and the
 * row count, never the rows. A search term may be a name, so it is masked in the audit entry.
 */
import ExcelJS from 'exceljs'

import type { Actor, Scope } from '../../lib/scoping.js'
import { inTransaction } from '../../lib/transaction.js'
import { exportFarmerRows, type FarmerFilters } from '../../selectors/registry.selectors.js'
import { exportInventoryRows, type RecordFilters } from '../../selectors/survey.selectors.js'
import { REDACTED, recordAudit } from '../audit.service.js'

type Cell = string | number | null

async function workbookOf(title: string, headers: string[], rows: Cell[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet(title.slice(0, 31), {
    views: [{ state: 'frozen', ySplit: 1 }],
  })
  sheet.addRow(headers).font = { bold: true }
  sheet.addRows(rows)
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

async function auditExport(
  actor: Actor,
  action: string,
  objectType: string,
  rows: number,
  filters: Record<string, unknown>,
): Promise<void> {
  const shown = { ...filters, ...(filters.q ? { q: REDACTED } : {}) }
  await inTransaction((session) =>
    recordAudit({
      actorId: actor.id,
      action,
      objectType,
      objectId: '',
      after: { rows, filters: shown },
      session,
    }),
  )
}

export async function exportFarmers(
  actor: Actor,
  scope: Scope,
  filters: FarmerFilters,
  rawFilters: Record<string, unknown>,
): Promise<Buffer> {
  const rows = await exportFarmerRows(scope, filters)
  const data = await workbookOf(
    'Farmers',
    [
      'Last name',
      'First name',
      'Middle name',
      'Suffix',
      'Sex',
      'Birth year',
      'RSBSA no.',
      'Contact no.',
      'Barangay',
      'Municipality',
      'Associations',
      'Status',
      'Consent',
    ],
    rows,
  )
  await auditExport(actor, 'export.farmers', 'farmer', rows.length, rawFilters)
  return data
}

export async function exportInventory(
  actor: Actor,
  scope: Scope,
  filters: RecordFilters,
  rawFilters: Record<string, unknown>,
): Promise<Buffer> {
  const { labels, rows } = await exportInventoryRows(scope, filters)
  const data = await workbookOf(
    'Inventory',
    [
      'Round',
      'Commodity',
      'Municipality',
      'Barangay',
      'Farmer',
      ...labels,
      'Total',
      'Status',
      'Remarks',
    ],
    rows,
  )
  await auditExport(actor, 'export.inventory', 'inventory_record', rows.length, rawFilters)
  return data
}
