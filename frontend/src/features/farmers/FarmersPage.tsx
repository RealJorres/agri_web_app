import type { ColumnDef } from '@tanstack/react-table'
import { Download, Plus, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { Button } from '@/components/ui/Button'
import { DataTable } from '@/components/ui/DataTable'
import { Alert, PageHeader, StatusBadge } from '@/components/ui/display'
import { SelectInput } from '@/components/ui/fields'
import { useToast } from '@/components/ui/useToast'
import { download } from '@/lib/api/client'
import { useAuth } from '@/lib/auth/context'
import { errorMessage } from '@/lib/forms'
import { useBarangays, useMunicipalities } from '@/lib/reference'
import { useTableParams } from '@/lib/useTableParams'

import { useFarmers, type Farmer, type FarmerListParams } from './api'

const FILTERS = ['q', 'municipality', 'barangay', 'status'] as const

const columns: ColumnDef<Farmer>[] = [
  {
    id: 'last_name',
    header: 'Name',
    cell: ({ row }) => (
      <Link
        to={`/farmers/${row.original.id}`}
        className="font-medium text-brand-800 hover:underline"
      >
        {row.original.display_name}
      </Link>
    ),
  },
  {
    id: 'barangay',
    header: 'Barangay',
    enableSorting: false,
    cell: ({ row }) => row.original.home_barangay.name,
  },
  {
    id: 'municipality',
    header: 'Municipality',
    enableSorting: false,
    cell: ({ row }) => row.original.municipality.name,
  },
  {
    id: 'rsbsa',
    header: 'RSBSA no.',
    enableSorting: false,
    cell: ({ row }) => row.original.rsbsa_no ?? '—',
  },
  {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  },
  {
    id: 'created_at',
    header: 'Added',
    cell: ({ row }) => new Date(row.original.created_at).toLocaleDateString('en-PH'),
  },
]

/** Debounce a value so search requests are not sent on every keystroke. */
function useDebounced<T>(value: T, ms = 350): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebounced(value)
    }, ms)
    return () => {
      window.clearTimeout(handle)
    }
  }, [value, ms])
  return debounced
}

export default function FarmersPage() {
  const navigate = useNavigate()
  const notify = useToast()
  const { can } = useAuth()
  const table = useTableParams(FILTERS)
  const [search, setSearch] = useState(table.filters.q ?? '')
  const debounced = useDebounced(search)
  const { setFilter } = table
  const currentQ = table.filters.q ?? null
  useEffect(() => {
    const next = debounced.trim() || null
    if (next !== currentQ) setFilter('q', next) // only on a real change: keeps ?page on reload
  }, [debounced, currentQ, setFilter])

  const municipalities = useMunicipalities()
  const barangays = useBarangays(table.filters.municipality)
  const params: FarmerListParams = useMemo(
    () => ({
      page: table.page,
      ...(table.ordering ? { ordering: table.ordering } : {}),
      ...table.filters,
    }),
    [table.page, table.ordering, table.filters],
  )
  const farmers = useFarmers(params)

  const exportList = async () => {
    const query = new URLSearchParams(table.filters).toString()
    try {
      await download(`/api/v1/exports/farmers.xlsx${query ? `?${query}` : ''}`, 'farmers.xlsx')
    } catch (err) {
      notify(errorMessage(err), 'error')
    }
  }

  return (
    <>
      <PageHeader
        title="Farmers"
        description="Registered farmers within your assignment."
        actions={
          <>
            {can('export_personal_data') ? (
              <Button
                variant="secondary"
                icon={<Download className="h-4 w-4" aria-hidden="true" />}
                onClick={() => void exportList()}
              >
                Export
              </Button>
            ) : null}
            {can('edit_records') ? (
              <Button
                icon={<Plus className="h-4 w-4" aria-hidden="true" />}
                onClick={() => void navigate('/farmers/new')}
              >
                New farmer
              </Button>
            ) : null}
          </>
        }
      />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1 sm:col-span-2 lg:col-span-1">
          <label htmlFor="farmer-search" className="block text-sm font-medium">
            Search
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted"
              aria-hidden="true"
            />
            <input
              id="farmer-search"
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
              }}
              placeholder="Name or RSBSA no."
              className="block w-full rounded-md border border-slate-300 py-2 pl-8 pr-3 text-sm"
            />
          </div>
        </div>
        <SelectInput
          label="Municipality"
          value={table.filters.municipality ?? ''}
          onChange={(e) => {
            table.update({ municipality: e.target.value || null, barangay: null })
          }}
        >
          <option value="">All</option>
          {municipalities.data?.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </SelectInput>
        <SelectInput
          label="Barangay"
          value={table.filters.barangay ?? ''}
          disabled={!table.filters.municipality}
          onChange={(e) => {
            table.setFilter('barangay', e.target.value || null)
          }}
        >
          <option value="">All</option>
          {barangays.data?.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </SelectInput>
        <SelectInput
          label="Status"
          value={table.filters.status ?? ''}
          onChange={(e) => {
            table.setFilter('status', e.target.value || null)
          }}
        >
          <option value="">All</option>
          <option value="active">Active</option>
          <option value="needs_review">Needs review</option>
          <option value="inactive">Inactive</option>
        </SelectInput>
      </div>
      {farmers.isError ? (
        <Alert tone="error">{errorMessage(farmers.error)}</Alert>
      ) : (
        <DataTable
          caption="Farmers"
          columns={columns}
          data={farmers.data?.results ?? []}
          total={farmers.data?.count ?? 0}
          page={table.page}
          onPageChange={table.setPage}
          sorting={table.sorting}
          onSortingChange={table.setSorting}
          loading={farmers.isPending}
          getRowId={(row) => row.id}
          empty="No farmers match these filters."
        />
      )}
    </>
  )
}
