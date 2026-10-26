import { Download } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/Button'
import { Alert, Card, EmptyState } from '@/components/ui/display'
import { SelectInput } from '@/components/ui/fields'
import { LoadingBlock } from '@/components/ui/Spinner'
import { downloadCsv } from '@/lib/csv'
import { errorMessage } from '@/lib/forms'
import { formatNumber } from '@/lib/format'

import { useHarvestSummary } from './api'

const KG_COLUMNS = [
  ['wet_beans', 'Wet beans (kg)'],
  ['dried_beans', 'Dried beans (kg)'],
  ['pods', 'Pods (kg)'],
  ['unknown', 'Form not recorded (kg)'],
] as const

/** Reported harvests per municipality (ADR-0018). A table, not a chart: the units differ and
 * must not be added together. */
export function HarvestSummaryCard({ commodity, town }: { commodity?: string; town?: string }) {
  const [year, setYear] = useState<number | undefined>(undefined)
  const summary = useHarvestSummary({
    ...(commodity ? { commodity } : {}),
    ...(year ? { year } : {}),
  })
  const rows = (summary.data?.rows ?? []).filter((r) => !town || r.municipality === town)

  const columns = [
    'Municipality',
    'Harvests',
    'Farmers',
    ...KG_COLUMNS.map(([, label]) => label),
    'Sacks',
    'Other units (entries)',
    'Date estimated',
  ]
  const table = rows.map((r) => [
    r.municipality,
    r.harvests,
    r.farmers,
    ...KG_COLUMNS.map(([k]) => Number(r.kg[k])),
    Number(r.sacks),
    r.other_entries,
    r.estimated_dates,
  ])

  return (
    <Card
      title="Reported harvests"
      actions={
        <div className="flex flex-wrap items-end gap-2">
          <SelectInput
            label="Year"
            value={year ?? ''}
            onChange={(e) => setYear(e.target.value ? Number(e.target.value) : undefined)}
            className="w-36"
          >
            <option value="">All years</option>
            {(summary.data?.years ?? []).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </SelectInput>
          <Button
            size="sm"
            variant="secondary"
            disabled={rows.length === 0}
            icon={<Download className="h-4 w-4" aria-hidden="true" />}
            onClick={() =>
              downloadCsv(`harvests-${year ? String(year) : 'all-years'}.csv`, columns, table)
            }
          >
            CSV
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">
          As reported by farmers; harvests are not validated like inventory records. Kilograms are
          shown per product, and sacks are not converted until the PAO sets a sack weight.
        </p>
        {summary.data && summary.data.undated_excluded > 0 ? (
          <Alert tone="info">
            {formatNumber(summary.data.undated_excluded)} harvests without a date are not included
            in {year}.
          </Alert>
        ) : null}
        {summary.isPending ? (
          <LoadingBlock />
        ) : summary.isError ? (
          <Alert tone="error">{errorMessage(summary.error)}</Alert>
        ) : rows.length === 0 ? (
          <EmptyState title="No harvests reported" />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <caption className="sr-only">Reported harvests by municipality</caption>
              <thead>
                <tr className="text-muted">
                  {columns.map((c, i) => (
                    <th
                      key={c}
                      scope="col"
                      className={`py-1.5 font-medium ${i === 0 ? 'text-left' : 'pl-3 text-right'}`}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.map(([name, ...values]) => (
                  <tr key={String(name)} className="border-t border-line">
                    <th scope="row" className="py-2 text-left font-medium">
                      {name}
                    </th>
                    {values.map((v, i) => (
                      <td key={i} className="py-2 pl-3 text-right tabular-nums">
                        {v ? formatNumber(v) : <span className="text-muted">0</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  )
}
