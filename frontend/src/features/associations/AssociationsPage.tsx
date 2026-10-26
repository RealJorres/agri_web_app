import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Link } from 'react-router'

import { DataTable } from '@/components/ui/DataTable'
import { Alert, PageHeader } from '@/components/ui/display'
import { SelectInput } from '@/components/ui/fields'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { errorMessage } from '@/lib/forms'
import { formatNumber } from '@/lib/format'
import { useMunicipalities } from '@/lib/reference'
import { useTableParams } from '@/lib/useTableParams'

type Association = Schemas['Association']
const FILTERS = ['municipality', 'q'] as const

const TYPE_LABELS: Record<string, string> = {
  farmers_association: 'Farmers association',
  cooperative: 'Cooperative',
  irrigators_association: 'Irrigators association',
  other: 'Other',
}

const columns: ColumnDef<Association>[] = [
  {
    id: 'name',
    header: 'Name',
    cell: ({ row }) => (
      <Link
        to={`/associations/${row.original.id}`}
        className="font-medium text-brand-800 hover:underline"
      >
        {row.original.name}
      </Link>
    ),
  },
  {
    id: 'type',
    header: 'Type',
    enableSorting: false,
    cell: ({ row }) => TYPE_LABELS[row.original.type ?? 'other'],
  },
  {
    id: 'municipality',
    header: 'Municipality',
    enableSorting: false,
    cell: ({ row }) => row.original.municipality_name,
  },
  {
    id: 'members',
    header: 'Members',
    enableSorting: false,
    cell: ({ row }) => formatNumber(row.original.member_count),
  },
]

export default function AssociationsPage() {
  const table = useTableParams(FILTERS)
  const municipalities = useMunicipalities()
  const associations = useQuery({
    queryKey: ['associations', table.page, table.ordering, table.filters],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/associations', {
          params: {
            query: {
              page: table.page,
              ...(table.ordering ? { ordering: table.ordering } : {}),
              ...table.filters,
            },
          },
        }),
      ),
    placeholderData: keepPreviousData,
  })

  return (
    <>
      <PageHeader title="Associations" description="Farmers associations and cooperatives." />
      <div className="mb-4 max-w-xs">
        <SelectInput
          label="Municipality"
          value={table.filters.municipality ?? ''}
          onChange={(e) => {
            table.setFilter('municipality', e.target.value || null)
          }}
        >
          <option value="">All</option>
          {municipalities.data?.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </SelectInput>
      </div>
      {associations.isError ? (
        <Alert tone="error">{errorMessage(associations.error)}</Alert>
      ) : (
        <DataTable
          caption="Associations"
          columns={columns}
          data={associations.data?.results ?? []}
          total={associations.data?.count ?? 0}
          page={table.page}
          onPageChange={table.setPage}
          sorting={table.sorting}
          onSortingChange={table.setSorting}
          loading={associations.isPending}
          getRowId={(row) => row.id}
        />
      )}
    </>
  )
}
