import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { useState, type SyntheticEvent } from 'react'
import { Link, useParams } from 'react-router'

import { Button } from '@/components/ui/Button'
import { Alert, Card, DefinitionList, EmptyState, PageHeader } from '@/components/ui/display'
import { SelectInput, TextInput } from '@/components/ui/fields'
import { LoadingBlock } from '@/components/ui/Spinner'
import { useToast } from '@/components/ui/useToast'
import { api, unwrap } from '@/lib/api/client'
import { useAuth } from '@/lib/auth/context'
import { errorMessage } from '@/lib/forms'
import { formatDate } from '@/lib/format'

export default function AssociationDetailPage() {
  const { id = '' } = useParams()
  const { can } = useAuth()
  const association = useQuery({
    queryKey: ['association', id],
    queryFn: async () =>
      unwrap(await api.GET('/api/v1/associations/{id}', { params: { path: { id } } })),
  })
  const members = useQuery({
    queryKey: ['association', id, 'members'],
    queryFn: async () =>
      unwrap(await api.GET('/api/v1/associations/{id}/members', { params: { path: { id } } })),
  })

  if (association.isPending) return <LoadingBlock />
  if (association.isError)
    return <Alert tone="error">Association not found or not in your assignment.</Alert>
  const a = association.data
  return (
    <>
      <PageHeader title={a.name} description={a.municipality_name} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card title="Members" className="lg:col-span-2">
          {members.isPending ? (
            <LoadingBlock />
          ) : members.isError ? (
            <Alert tone="error">{errorMessage(members.error)}</Alert>
          ) : members.data.results.length === 0 ? (
            <EmptyState title="No members yet" />
          ) : (
            <ul className="divide-y divide-line">
              {members.data.results.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div>
                    <Link
                      to={`/farmers/${m.farmer}`}
                      className="font-medium text-brand-800 hover:underline"
                    >
                      {m.farmer_name}
                    </Link>
                    <span className="text-muted">
                      {' '}
                      · {m.home_barangay}
                      {m.role ? ` · ${m.role}` : ''}
                      {m.since ? ` · since ${formatDate(m.since)}` : ''}
                    </span>
                  </div>
                  {can('edit_records') ? <RemoveMember associationId={id} memberId={m.id} /> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="space-y-6">
          <Card title="Details">
            <DefinitionList
              items={[
                ['Short name', a.short_name || '—'],
                ['Registered with', a.registration_body || '—'],
                ['Registration no.', a.registration_no || '—'],
              ]}
            />
          </Card>
          {can('edit_records') ? <AddMember associationId={id} /> : null}
        </div>
      </div>
    </>
  )
}

function RemoveMember({ associationId, memberId }: { associationId: string; memberId: string }) {
  const queryClient = useQueryClient()
  const notify = useToast()
  const remove = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.DELETE('/api/v1/associations/{id}/members/{member_id}', {
          params: { path: { id: associationId, member_id: memberId } },
        }),
      ),
    onSuccess: async () => {
      notify('Member removed.')
      await queryClient.invalidateQueries({ queryKey: ['association', associationId] })
    },
    onError: (err) => {
      notify(errorMessage(err), 'error')
    },
  })
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label="Remove member"
      loading={remove.isPending}
      icon={<Trash2 className="h-4 w-4" aria-hidden="true" />}
      onClick={() => {
        remove.mutate()
      }}
    />
  )
}

function AddMember({ associationId }: { associationId: string }) {
  const queryClient = useQueryClient()
  const notify = useToast()
  const [query, setQuery] = useState('')
  const [farmer, setFarmer] = useState('')
  const [role, setRole] = useState('')
  const [error, setError] = useState<string | null>(null)
  const matches = useQuery({
    queryKey: ['farmers', { q: query, for: 'member' }],
    queryFn: async () =>
      unwrap(await api.GET('/api/v1/farmers', { params: { query: { q: query } } })),
    enabled: query.trim().length >= 3,
  })
  const add = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST('/api/v1/associations/{id}/members', {
          params: { path: { id: associationId } },
          body: { farmer, role },
        }),
      ),
    onSuccess: async () => {
      notify('Member added.')
      setFarmer('')
      setRole('')
      setQuery('')
      await queryClient.invalidateQueries({ queryKey: ['association', associationId] })
    },
    onError: (err) => {
      setError(errorMessage(err))
    },
  })
  const submit = (event: SyntheticEvent) => {
    event.preventDefault()
    setError(null)
    if (farmer) add.mutate()
  }
  return (
    <Card title="Add member">
      <form className="space-y-3" onSubmit={submit}>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <TextInput
          label="Find farmer"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          hint="Type at least 3 letters."
        />
        <SelectInput
          label="Farmer"
          required
          value={farmer}
          onChange={(e) => setFarmer(e.target.value)}
        >
          <option value="">Choose…</option>
          {matches.data?.results.map((f) => (
            <option key={f.id} value={f.id}>
              {f.display_name} ({f.home_barangay.name})
            </option>
          ))}
        </SelectInput>
        <TextInput
          label="Role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="e.g. Member, Treasurer"
        />
        <Button type="submit" loading={add.isPending} disabled={!farmer}>
          Add member
        </Button>
      </form>
    </Card>
  )
}
