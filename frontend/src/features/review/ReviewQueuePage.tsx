import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { useState } from 'react'
import { Link } from 'react-router'

import { DataTable } from '@/components/ui/DataTable'
import { Dialog } from '@/components/ui/Dialog'
import { Alert, Badge, DefinitionList, PageHeader, StatusBadge } from '@/components/ui/display'
import { SelectInput } from '@/components/ui/fields'
import { api, unwrap } from '@/lib/api/client'
import { useAuth } from '@/lib/auth/context'
import { errorMessage } from '@/lib/forms'
import { formatDateTime, formatNumber } from '@/lib/format'
import { useMunicipalities, useRounds } from '@/lib/reference'
import { useTableParams } from '@/lib/useTableParams'

import { useRecord, type InventoryRecord } from '../surveys/api'
import { CommentHistory, RecordFlags, WorkflowActions } from '../surveys/WorkflowActions'

const FILTERS = ['status', 'survey_round', 'municipality'] as const

function warningCount(record: InventoryRecord): number {
  const flags = record.flags as { warnings?: unknown[] } | undefined
  return flags?.warnings?.length ?? 0
}

const columns: ColumnDef<InventoryRecord>[] = [
  {
    id: 'farmer',
    header: 'Farmer',
    enableSorting: false,
    cell: ({ row }) => row.original.farmer.display_name,
  },
  {
    id: 'place',
    header: 'Farm',
    enableSorting: false,
    cell: ({ row }) => `${row.original.farm.barangay}, ${row.original.farm.municipality}`,
  },
  {
    id: 'round',
    header: 'Round',
    enableSorting: false,
    cell: ({ row }) => row.original.survey_round.name,
  },
  {
    id: 'total',
    header: 'Trees',
    enableSorting: false,
    cell: ({ row }) => formatNumber(row.original.total),
  },
  {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => (
      <span className="inline-flex items-center gap-2">
        <StatusBadge status={row.original.status} />
        {warningCount(row.original) ? (
          <Badge tone="amber">{warningCount(row.original)} warning(s)</Badge>
        ) : null}
      </span>
    ),
  },
  {
    id: 'submitted_at',
    header: 'Submitted',
    cell: ({ row }) => formatDateTime(row.original.submitted_at),
  },
]

export default function ReviewQueuePage() {
  const { can } = useAuth()
  const table = useTableParams(FILTERS)
  // Validators see what awaits validation; coordinators see what awaits approval.
  const defaultStatus = can('validate') ? 'submitted' : 'validated'
  const status = table.filters.status ?? defaultStatus
  const rounds = useRounds({ status: 'open' })
  const municipalities = useMunicipalities()
  const [selected, setSelected] = useState<string | null>(null)

  const records = useQuery({
    queryKey: ['inventory-records', 'review', table.page, table.ordering, status, table.filters],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/inventory-records', {
          params: {
            query: {
              page: table.page,
              ordering: table.ordering || 'submitted_at',
              status: [status as InventoryRecord['status']],
              ...(table.filters.survey_round ? { survey_round: table.filters.survey_round } : {}),
              ...(table.filters.municipality ? { municipality: table.filters.municipality } : {}),
            },
          },
        }),
      ),
    placeholderData: keepPreviousData,
  })

  return (
    <>
      <PageHeader
        title="Review queue"
        description="Records waiting for your decision, oldest first."
      />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SelectInput
          label="Status"
          value={status}
          onChange={(e) => {
            table.setFilter('status', e.target.value)
          }}
        >
          <option value="submitted">Submitted (awaiting validation)</option>
          <option value="validated">Validated (awaiting approval)</option>
          <option value="approved">Approved</option>
        </SelectInput>
        <SelectInput
          label="Round"
          value={table.filters.survey_round ?? ''}
          onChange={(e) => {
            table.setFilter('survey_round', e.target.value || null)
          }}
        >
          <option value="">All open rounds</option>
          {rounds.data?.results.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </SelectInput>
        <SelectInput
          label="Municipality"
          value={table.filters.municipality ?? ''}
          onChange={(e) => {
            table.setFilter('municipality', e.target.value || null)
          }}
        >
          <option value="">All in my assignment</option>
          {municipalities.data?.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </SelectInput>
      </div>
      {records.isError ? (
        <Alert tone="error">{errorMessage(records.error)}</Alert>
      ) : (
        <DataTable
          caption="Records awaiting review"
          columns={columns}
          data={records.data?.results ?? []}
          total={records.data?.count ?? 0}
          page={table.page}
          onPageChange={table.setPage}
          sorting={table.sorting}
          onSortingChange={table.setSorting}
          loading={records.isPending}
          onRowClick={(row) => {
            setSelected(row.id)
          }}
          getRowId={(row) => row.id}
          empty="Nothing to review. Well done!"
        />
      )}
      <ReviewPanel
        id={selected}
        onClose={() => {
          setSelected(null)
        }}
      />
    </>
  )
}

function ReviewPanel({ id, onClose }: { id: string | null; onClose: () => void }) {
  const record = useRecord(id ?? undefined)
  const r = record.data
  return (
    <Dialog
      open={id !== null}
      onClose={onClose}
      variant="drawer"
      title={r ? r.farmer.display_name : 'Record'}
    >
      {!r ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <div className="space-y-5">
          <DefinitionList
            items={[
              ['Farm', `${r.farm.barangay}, ${r.farm.municipality}`],
              ['Round', r.survey_round.name],
              ['Status', <StatusBadge key="s" status={r.status} />],
              ['Version', r.version],
            ]}
          />
          <table className="w-full text-sm">
            <caption className="sr-only">Stage counts</caption>
            <tbody>
              {r.counts.map((c, i) => (
                <tr key={i} className="border-b border-line">
                  <th scope="row" className="py-1.5 text-left font-normal">
                    {c.growth_stage.label}
                  </th>
                  <td className="py-1.5 text-right tabular-nums">{formatNumber(c.count)}</td>
                </tr>
              ))}
              <tr>
                <th scope="row" className="py-1.5 text-left font-semibold">
                  Total
                </th>
                <td className="py-1.5 text-right font-semibold tabular-nums">
                  {formatNumber(r.total)}
                </td>
              </tr>
            </tbody>
          </table>
          {r.remarks ? <p className="rounded-md bg-slate-50 p-2 text-sm">{r.remarks}</p> : null}
          <RecordFlags record={r} />
          <CommentHistory recordId={r.id} />
          <WorkflowActions record={r} exclude={['submit']} onDone={onClose} />
          <Link
            to={`/inventory/${r.id}`}
            className="inline-block text-sm font-medium text-brand-800 hover:underline"
          >
            Open full record
          </Link>
        </div>
      )}
    </Dialog>
  )
}
