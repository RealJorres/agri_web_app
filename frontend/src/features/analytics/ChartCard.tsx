import { Download, Table2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { Card } from '@/components/ui/display'
import { downloadCsv } from '@/lib/csv'

export interface TableData {
  columns: string[]
  rows: (string | number | null)[][]
}

/** Every chart has a table view and a CSV download: values are never tooltip-only. */
export function ChartCard({
  title,
  subtitle,
  table,
  filename,
  legend,
  children,
}: {
  title: string
  subtitle?: ReactNode
  table: TableData
  filename: string
  legend?: ReactNode
  children: ReactNode
}) {
  const [asTable, setAsTable] = useState(false)
  return (
    <Card
      title={title}
      description={subtitle}
      actions={
        <div className="flex gap-1">
          <button
            type="button"
            aria-pressed={asTable}
            onClick={() => setAsTable(!asTable)}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-muted transition hover:bg-sunken hover:text-ink aria-pressed:bg-brand-50 aria-pressed:text-brand-800"
          >
            <Table2 className="h-3.5 w-3.5" aria-hidden="true" />
            {asTable ? 'Chart' : 'Table'}
          </button>
          <button
            type="button"
            onClick={() => downloadCsv(filename, table.columns, table.rows)}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-muted transition hover:bg-sunken hover:text-ink aria-pressed:bg-brand-50 aria-pressed:text-brand-800"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            CSV
          </button>
        </div>
      }
    >
      {asTable ? (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr className="text-left text-muted">
                {table.columns.map((c, i) => (
                  <th
                    key={c}
                    scope="col"
                    className={`py-1.5 pr-4 font-medium ${i > 0 ? 'text-right' : ''}`}
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, r) => (
                <tr key={r} className="border-t border-line">
                  {row.map((cell, i) =>
                    i === 0 ? (
                      <th key={i} scope="row" className="py-1.5 pr-4 text-left font-normal">
                        {cell ?? '—'}
                      </th>
                    ) : (
                      <td key={i} className="py-1.5 pr-4 text-right tabular-nums">
                        {typeof cell === 'number' ? cell.toLocaleString('en-PH') : (cell ?? '—')}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          {legend}
          {children}
        </>
      )}
    </Card>
  )
}

export function StageLegend({ stages }: { stages: { label: string; color: string }[] }) {
  return (
    <ul
      className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs font-medium text-muted"
      aria-label="Legend"
    >
      {stages.map((s) => (
        <li key={s.label} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: s.color }}
          />
          {s.label}
        </li>
      ))}
    </ul>
  )
}
