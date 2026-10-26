import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table'
import clsx from 'clsx'
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react'

import { Spinner } from './Spinner'

export const PAGE_SIZE = 50

interface DataTableProps<T> {
  columns: ColumnDef<T>[]
  data: T[]
  total: number
  page: number
  onPageChange: (page: number) => void
  sorting?: SortingState
  onSortingChange?: (sorting: SortingState) => void
  loading?: boolean
  onRowClick?: (row: T) => void
  caption: string
  empty?: string
  getRowId?: (row: T) => string
}

/** Server-side table: the API does paging and sorting; this only renders and reports intent. */
export function DataTable<T>({
  columns,
  data,
  total,
  page,
  onPageChange,
  sorting = [],
  onSortingChange,
  loading,
  onRowClick,
  caption,
  empty = 'No results.',
  getRowId,
}: DataTableProps<T>) {
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table v8 returns mutable functions
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    state: { sorting },
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(sorting) : updater
      onSortingChange?.(next)
    },
    ...(getRowId ? { getRowId } : {}),
  })
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const first = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const last = Math.min(page * PAGE_SIZE, total)

  return (
    <div className="rounded-lg border border-line bg-surface shadow-sm">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-line text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-slate-50">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  // Display columns have no accessor, so TanStack would refuse to sort them;
                  // the server sorts, so any column not opted out is sortable here.
                  const canSort =
                    Boolean(onSortingChange) && header.column.columnDef.enableSorting !== false
                  const current = sorting.find((s) => s.id === header.column.id)
                  const dir = current ? (current.desc ? 'desc' : 'asc') : false
                  const toggle = () => {
                    const next = !current
                      ? [{ id: header.column.id, desc: false }]
                      : current.desc
                        ? []
                        : [{ id: header.column.id, desc: true }]
                    onSortingChange?.(next)
                  }
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={
                        dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined
                      }
                      className="whitespace-nowrap px-4 py-2.5 text-left font-semibold text-ink"
                    >
                      {canSort ? (
                        <button
                          type="button"
                          onClick={toggle}
                          className="inline-flex items-center gap-1 hover:text-brand-800"
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {dir === 'asc' ? (
                            <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : dir === 'desc' ? (
                            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : (
                            <ArrowUpDown
                              className="h-3.5 w-3.5 text-slate-400"
                              aria-hidden="true"
                            />
                          )}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-line">
            {loading ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-10 text-center text-brand-700">
                  <Spinner label="Loading…" />
                </td>
              </tr>
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-10 text-center text-muted">
                  {empty}
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className={clsx(
                    onRowClick && 'cursor-pointer hover:bg-brand-50 focus-within:bg-brand-50',
                  )}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="whitespace-nowrap px-4 py-2.5 text-ink">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <nav
        aria-label="Pagination"
        className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2 text-sm"
      >
        <span className="text-muted">
          {total === 0 ? '0 results' : `${String(first)}–${String(last)} of ${String(total)}`}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded p-1.5 hover:bg-slate-100 disabled:opacity-40"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <span className="px-2 text-muted">
            Page {page} of {pages}
          </span>
          <button
            type="button"
            className="rounded p-1.5 hover:bg-slate-100 disabled:opacity-40"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= pages}
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </nav>
    </div>
  )
}
