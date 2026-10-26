import type { ColumnDef } from '@tanstack/react-table'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { DataTable } from './DataTable'

interface Row {
  id: string
  name: string
}
const columns: ColumnDef<Row>[] = [
  { id: 'name', header: 'Name', cell: ({ row }) => row.original.name },
  { id: 'plain', header: 'Plain', enableSorting: false, cell: () => 'x' },
]
const rows: Row[] = [
  { id: '1', name: 'Alpha' },
  { id: '2', name: 'Beta' },
]

describe('DataTable', () => {
  it('renders rows and reports sort intent to the server', async () => {
    const onSortingChange = vi.fn()
    render(
      <DataTable
        caption="Test"
        columns={columns}
        data={rows}
        total={2}
        page={1}
        onPageChange={vi.fn()}
        sorting={[{ id: 'name', desc: false }]}
        onSortingChange={onSortingChange}
      />,
    )

    expect(screen.getAllByRole('row')).toHaveLength(3)
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )
    expect(screen.queryByRole('button', { name: /Plain/ })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Name/ }))

    expect(onSortingChange).toHaveBeenCalledWith([{ id: 'name', desc: true }])
  })

  it('paginates by 50', async () => {
    const onPageChange = vi.fn()
    render(
      <DataTable
        caption="Test"
        columns={columns}
        data={rows}
        total={120}
        page={2}
        onPageChange={onPageChange}
      />,
    )

    expect(screen.getByText('51–100 of 120')).toBeInTheDocument()
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await userEvent.click(screen.getByRole('button', { name: 'Previous page' }))

    expect(onPageChange.mock.calls).toEqual([[3], [1]])
  })

  it('shows empty and loading states', () => {
    const { rerender } = render(
      <DataTable
        caption="Test"
        columns={columns}
        data={[]}
        total={0}
        page={1}
        onPageChange={vi.fn()}
        empty="Nothing here."
      />,
    )
    expect(screen.getByText('Nothing here.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()

    rerender(
      <DataTable
        caption="Test"
        columns={columns}
        data={[]}
        total={0}
        page={1}
        onPageChange={vi.fn()}
        loading
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Loading')
  })
})
