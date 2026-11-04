import { zodResolver } from '@hookform/resolvers/zod'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link, useNavigate } from 'react-router'
import { z } from 'zod'

import { Button } from '@/components/ui/Button'
import { DataTable } from '@/components/ui/DataTable'
import { Dialog } from '@/components/ui/Dialog'
import { Alert, Avatar, FilterBar, PageHeader, StatusBadge } from '@/components/ui/display'
import { TextInput } from '@/components/ui/fields'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { applyServerErrors, errorMessage } from '@/lib/forms'
import { formatDateTime } from '@/lib/format'
import { useTableParams } from '@/lib/useTableParams'

type User = Schemas['AdminUser']
const FILTERS = ['q'] as const

const columns: ColumnDef<User>[] = [
  {
    id: 'name',
    header: 'Name',
    enableSorting: false,
    cell: ({ row }) => (
      <Link
        to={`/admin/users/${row.original.id}`}
        className="group inline-flex items-center gap-2.5 font-semibold text-ink"
      >
        <Avatar name={row.original.full_name || row.original.email} />
        <span className="group-hover:text-brand-700 group-hover:underline">
          {row.original.full_name || row.original.email}
        </span>
      </Link>
    ),
  },
  { id: 'email', header: 'Email', enableSorting: false, cell: ({ row }) => row.original.email },
  {
    id: 'roles',
    header: 'Roles',
    enableSorting: false,
    cell: ({ row }) => {
      const roles = row.original.assignments.map((a) => a.role_label)
      if (row.original.is_superuser) roles.unshift('Superuser')
      return roles.length ? [...new Set(roles)].join(', ') : 'No role yet'
    },
  },
  {
    id: 'status',
    header: 'Status',
    enableSorting: false,
    cell: ({ row }) => <StatusBadge status={row.original.is_active ? 'active' : 'inactive'} />,
  },
  {
    id: 'last_login',
    header: 'Last sign-in',
    enableSorting: false,
    cell: ({ row }) => formatDateTime(row.original.last_login_at),
  },
]

export default function UsersPage() {
  const { page, filters, setPage, setFilter } = useTableParams(FILTERS)
  const [creating, setCreating] = useState(false)
  const users = useQuery({
    queryKey: ['admin-users', page, filters],
    queryFn: async () =>
      unwrap(await api.GET('/api/v1/admin/users', { params: { query: { page, ...filters } } })),
    placeholderData: keepPreviousData,
  })
  return (
    <>
      <PageHeader
        title="Users"
        description="Staff accounts and what each person may see and do."
        actions={
          <Button
            icon={<Plus className="h-4 w-4" aria-hidden="true" />}
            onClick={() => setCreating(true)}
          >
            New user
          </Button>
        }
      />
      <FilterBar className="sm:grid-cols-2 lg:grid-cols-3">
        <TextInput
          label="Search"
          type="search"
          defaultValue={filters.q ?? ''}
          placeholder="Name or email"
          onChange={(e) => setFilter('q', e.target.value.trim() || null)}
        />
      </FilterBar>
      {users.isError ? (
        <Alert tone="error">{errorMessage(users.error)}</Alert>
      ) : (
        <DataTable
          caption="Staff accounts"
          columns={columns}
          data={users.data?.results ?? []}
          total={users.data?.count ?? 0}
          page={page}
          onPageChange={setPage}
          loading={users.isPending}
          getRowId={(row) => row.id}
          empty="No accounts match."
        />
      )}
      <NewUserDialog
        open={creating}
        onClose={() => {
          setCreating(false)
        }}
      />
    </>
  )
}

const schema = z.object({
  email: z.email('Enter a valid email address.'),
  first_name: z.string().trim(),
  last_name: z.string().trim(),
  password: z.string().min(1, 'Set a starting password.'),
})
type Values = z.infer<typeof schema>

function NewUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', first_name: '', last_name: '', password: '' },
  })
  const create = useMutation({
    mutationFn: async (body: Values) => unwrap(await api.POST('/api/v1/admin/users', { body })),
  })
  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    try {
      const user = await create.mutateAsync(values)
      await queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      reset()
      onClose()
      await navigate(`/admin/users/${user.id}`)
    } catch (err) {
      setFormError(
        applyServerErrors(err, setError, ['email', 'first_name', 'last_name', 'password']),
      )
    }
  })
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New user"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="new-user" loading={create.isPending}>
            Create account
          </Button>
        </>
      }
    >
      <form id="new-user" className="space-y-4" onSubmit={(e) => void onSubmit(e)} noValidate>
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <TextInput
          label="Email"
          type="email"
          required
          autoComplete="off"
          error={errors.email?.message}
          {...register('email')}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextInput
            label="First name"
            error={errors.first_name?.message}
            {...register('first_name')}
          />
          <TextInput
            label="Last name"
            error={errors.last_name?.message}
            {...register('last_name')}
          />
        </div>
        <TextInput
          label="Starting password"
          type="password"
          required
          autoComplete="new-password"
          hint="Share it privately. The account has no access until you give it a role."
          error={errors.password?.message}
          {...register('password')}
        />
      </form>
    </Dialog>
  )
}
