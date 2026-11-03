import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link, useParams } from 'react-router'
import { z } from 'zod'

import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Alert, Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui/display'
import { SelectInput, TextInput } from '@/components/ui/fields'
import { LoadingBlock } from '@/components/ui/Spinner'
import { useToast } from '@/components/ui/useToast'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { useAuth } from '@/lib/auth/context'
import { applyServerErrors, errorMessage } from '@/lib/forms'
import { formatDateTime, ROLE_LABELS } from '@/lib/format'
import { useBarangays, useMunicipalities } from '@/lib/reference'

import { ConfirmDialog } from './shared'

type User = Schemas['AdminUser']
type Assignment = Schemas['Assignment']

function useRefresh(id: string) {
  const queryClient = useQueryClient()
  return async () => {
    await queryClient.invalidateQueries({ queryKey: ['admin-user', id] })
    await queryClient.invalidateQueries({ queryKey: ['admin-users'] })
  }
}

export default function UserDetailPage() {
  const { id = '' } = useParams()
  const user = useQuery({
    queryKey: ['admin-user', id],
    queryFn: async () =>
      unwrap(await api.GET('/api/v1/admin/users/{id}', { params: { path: { id } } })),
  })
  if (user.isPending) return <LoadingBlock />
  if (user.isError) return <Alert tone="error">{errorMessage(user.error)}</Alert>
  return <UserDetail key={user.data.id} user={user.data} />
}

function UserDetail({ user }: { user: User }) {
  const auth = useAuth()
  const notify = useToast()
  const refresh = useRefresh(user.id)
  const [resetting, setResetting] = useState(false)
  const [assigning, setAssigning] = useState(false)
  const [changingStatus, setChangingStatus] = useState(false)
  const [removing, setRemoving] = useState<Assignment | null>(null)
  const isSelf = auth.user?.id === user.id
  const setActive = async (is_active: boolean) => {
    unwrap(
      await api.PATCH('/api/v1/admin/users/{id}', {
        params: { path: { id: user.id } },
        body: { is_active },
      }),
    )
    await refresh()
    notify(is_active ? 'Account reactivated.' : 'Account deactivated.', 'success')
  }
  const remove = async (assignment: Assignment) => {
    unwrap(
      await api.DELETE('/api/v1/admin/users/{id}/assignments/{assignment_id}', {
        params: { path: { id: user.id, assignment_id: assignment.id } },
      }),
    )
    await refresh()
    notify('Role removed.', 'success')
  }
  return (
    <>
      <p className="mb-2 text-sm">
        <Link to="/admin/users" className="text-brand-800 hover:underline">
          ← Users
        </Link>
      </p>
      <PageHeader
        title={user.full_name || user.email}
        description={`Last sign-in: ${formatDateTime(user.last_login_at)}`}
        actions={<StatusBadge status={user.is_active ? 'active' : 'inactive'} />}
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ProfileCard user={user} />
        <Card
          title="Roles and scope"
          actions={
            <Button
              variant="secondary"
              icon={<Plus className="h-4 w-4" aria-hidden="true" />}
              onClick={() => setAssigning(true)}
            >
              Add role
            </Button>
          }
        >
          {user.is_superuser ? (
            <div className="mb-3">
              <Alert>This is a superuser account, with full access everywhere.</Alert>
            </div>
          ) : null}
          {user.assignments.length === 0 ? (
            <EmptyState title="No role yet">
              This person cannot see anything until given one.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {user.assignments.map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-3 py-2.5">
                  <div>
                    <p className="font-medium">{a.role_label}</p>
                    <p className="text-sm text-muted">
                      {a.municipality?.name ?? 'All municipalities'} ·{' '}
                      {a.program?.name ?? 'All programs'}
                      {a.barangays.length > 0
                        ? ` · ${a.barangays.map((b) => b.name).join(', ')}`
                        : ''}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    aria-label={`Remove ${a.role_label}`}
                    icon={<Trash2 className="h-4 w-4" aria-hidden="true" />}
                    onClick={() => setRemoving(a)}
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Access">
          <div className="flex flex-wrap gap-3">
            <Button
              variant="secondary"
              icon={<KeyRound className="h-4 w-4" aria-hidden="true" />}
              onClick={() => setResetting(true)}
            >
              Reset password
            </Button>
            {isSelf ? (
              <p className="self-center text-sm text-muted">
                You cannot deactivate your own account.
              </p>
            ) : (
              <Button
                variant={user.is_active ? 'danger' : 'secondary'}
                onClick={() => setChangingStatus(true)}
              >
                {user.is_active ? 'Deactivate account' : 'Reactivate account'}
              </Button>
            )}
          </div>
        </Card>
      </div>
      <PasswordDialog
        user={user}
        open={resetting}
        onClose={() => {
          setResetting(false)
        }}
      />
      <AssignmentDialog
        user={user}
        open={assigning}
        onClose={() => {
          setAssigning(false)
        }}
      />
      <ConfirmDialog
        open={changingStatus}
        title={user.is_active ? 'Deactivate this account?' : 'Reactivate this account?'}
        action={user.is_active ? 'Deactivate' : 'Reactivate'}
        onConfirm={() => setActive(!user.is_active)}
        onClose={() => {
          setChangingStatus(false)
        }}
      >
        {user.is_active
          ? 'They are signed out at once and cannot sign in. Their past work stays on record.'
          : 'They will be able to sign in again, with the roles shown here.'}
      </ConfirmDialog>
      <ConfirmDialog
        open={removing !== null}
        title="Remove this role?"
        action="Remove role"
        onConfirm={() => (removing ? remove(removing) : Promise.resolve())}
        onClose={() => {
          setRemoving(null)
        }}
      >
        {removing?.role_label} takes effect at once.
      </ConfirmDialog>
    </>
  )
}

const profileSchema = z.object({
  email: z.email('Enter a valid email address.'),
  first_name: z.string().trim(),
  last_name: z.string().trim(),
})
type ProfileValues = z.infer<typeof profileSchema>

function ProfileCard({ user }: { user: User }) {
  const notify = useToast()
  const refresh = useRefresh(user.id)
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ProfileValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: { email: user.email, first_name: user.first_name, last_name: user.last_name },
  })
  const onSubmit = handleSubmit(async (body) => {
    setFormError(null)
    try {
      unwrap(
        await api.PATCH('/api/v1/admin/users/{id}', { params: { path: { id: user.id } }, body }),
      )
      await refresh()
      notify('Saved.', 'success')
    } catch (err) {
      setFormError(applyServerErrors(err, setError, ['email', 'first_name', 'last_name']))
    }
  })
  return (
    <Card title="Profile">
      <form className="space-y-4" onSubmit={(e) => void onSubmit(e)} noValidate>
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <TextInput
          label="Email"
          type="email"
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
        <Button type="submit" loading={isSubmitting}>
          Save
        </Button>
      </form>
    </Card>
  )
}

const passwordSchema = z.object({ password: z.string().min(1, 'Enter a new password.') })

function PasswordDialog({
  user,
  open,
  onClose,
}: {
  user: User
  open: boolean
  onClose: () => void
}) {
  const notify = useToast()
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<{ password: string }>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { password: '' },
  })
  const close = () => {
    reset()
    setFormError(null)
    onClose()
  }
  const onSubmit = handleSubmit(async (body) => {
    setFormError(null)
    try {
      unwrap(
        await api.POST('/api/v1/admin/users/{id}/password', {
          params: { path: { id: user.id } },
          body,
        }),
      )
      notify('Password changed. They have been signed out everywhere.', 'success')
      close()
    } catch (err) {
      setFormError(applyServerErrors(err, setError, ['password']))
    }
  })
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Reset password"
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="reset-password" loading={isSubmitting}>
            Change password
          </Button>
        </>
      }
    >
      <form id="reset-password" className="space-y-4" onSubmit={(e) => void onSubmit(e)} noValidate>
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <TextInput
          label="New password"
          type="password"
          required
          autoComplete="new-password"
          hint="This signs them out on every device. Share the new password privately."
          error={errors.password?.message}
          {...register('password')}
        />
      </form>
    </Dialog>
  )
}

const ALL = ''

function AssignmentDialog({
  user,
  open,
  onClose,
}: {
  user: User
  open: boolean
  onClose: () => void
}) {
  const notify = useToast()
  const refresh = useRefresh(user.id)
  const municipalities = useMunicipalities()
  const programs = useQuery({
    queryKey: ['programs'],
    queryFn: async () => unwrap(await api.GET('/api/v1/programs')),
    enabled: open,
  })
  const [role, setRole] = useState('')
  const [municipality, setMunicipality] = useState(ALL)
  const [program, setProgram] = useState(ALL)
  const [barangayIds, setBarangayIds] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const barangays = useBarangays(municipality || undefined)
  const isAdminRole = role === 'system_admin'
  const limitsBarangays = role === 'field_encoder' && municipality !== ALL
  const close = () => {
    setRole('')
    setMunicipality(ALL)
    setProgram(ALL)
    setBarangayIds([])
    setError(null)
    onClose()
  }
  const add = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST('/api/v1/admin/users/{id}/assignments', {
          params: { path: { id: user.id } },
          body: {
            role,
            municipality: isAdminRole ? null : municipality || null,
            program: isAdminRole ? null : program || null,
            barangays: limitsBarangays ? barangayIds : [],
          },
        }),
      ),
  })
  const submit = async () => {
    setError(null)
    if (!role) {
      setError('Choose a role.')
      return
    }
    try {
      await add.mutateAsync()
      await refresh()
      notify('Role added.', 'success')
      close()
    } catch (err) {
      setError(errorMessage(err))
    }
  }
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add role"
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button loading={add.isPending} onClick={() => void submit()}>
            Add role
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <SelectInput label="Role" required value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">Choose…</option>
          {Object.entries(ROLE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectInput>
        {isAdminRole ? (
          <Alert tone="warning">
            A system admin covers the whole province and every program, and can change anyone’s
            access.
          </Alert>
        ) : (
          <>
            <SelectInput
              label="Municipality"
              value={municipality}
              onChange={(e) => {
                setMunicipality(e.target.value)
                setBarangayIds([])
              }}
            >
              <option value={ALL}>All municipalities</option>
              {municipalities.data?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </SelectInput>
            <SelectInput
              label="Program"
              value={program}
              onChange={(e) => setProgram(e.target.value)}
            >
              <option value={ALL}>All programs</option>
              {programs.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </SelectInput>
          </>
        )}
        {limitsBarangays ? (
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">Limit to barangays (optional)</legend>
            <p className="text-xs text-muted">Leave all unticked for the whole municipality.</p>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-line p-2">
              {barangays.data?.length === 0 ? (
                <p className="text-sm text-muted">No barangays are loaded for this town yet.</p>
              ) : null}
              {barangays.data?.map((b) => (
                <label key={b.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="accent-brand-700"
                    checked={barangayIds.includes(b.id)}
                    onChange={(e) => {
                      setBarangayIds((current) =>
                        e.target.checked
                          ? [...current, b.id]
                          : current.filter((value) => value !== b.id),
                      )
                    }}
                  />
                  {b.name}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
      </div>
    </Dialog>
  )
}
