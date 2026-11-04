import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Alert, EmptyState, PageHeader } from '@/components/ui/display'
import { TextArea, TextInput } from '@/components/ui/fields'
import { LoadingBlock } from '@/components/ui/Spinner'
import { useToast } from '@/components/ui/useToast'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { applyServerErrors, errorMessage } from '@/lib/forms'

import { aliasesFromText, ALIASES_HINT } from './catalog'
import { ConfirmDialog } from './shared'

type Source = Schemas['AdminMaterialSource']

export default function SourcesPage() {
  const queryClient = useQueryClient()
  const notify = useToast()
  const [editing, setEditing] = useState<Source | 'new' | null>(null)
  const [removing, setRemoving] = useState<Source | null>(null)
  const sources = useQuery({
    queryKey: ['admin-sources'],
    queryFn: async () => unwrap(await api.GET('/api/v1/admin/material-sources')),
  })
  const remove = async (source: Source) => {
    unwrap(
      await api.DELETE('/api/v1/admin/material-sources/{id}', {
        params: { path: { id: source.id } },
      }),
    )
    await queryClient.invalidateQueries({ queryKey: ['admin-sources'] })
    await queryClient.invalidateQueries({ queryKey: ['material-sources'] })
    notify('Source removed.', 'success')
  }
  return (
    <>
      <PageHeader
        title="Material sources"
        description="Where planting materials come from. These apply to every crop."
        actions={
          <Button
            icon={<Plus className="h-4 w-4" aria-hidden="true" />}
            onClick={() => setEditing('new')}
          >
            New source
          </Button>
        }
      />
      {sources.isPending ? (
        <LoadingBlock />
      ) : sources.isError ? (
        <Alert tone="error">{errorMessage(sources.error)}</Alert>
      ) : sources.data.length === 0 ? (
        <EmptyState title="No sources yet" />
      ) : (
        <ul className="divide-y divide-line surface-card">
          {sources.data.map((source) => (
            <li key={source.id} className="flex items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="font-medium">{source.name}</p>
                <p className="text-xs text-muted">
                  {source.code}
                  {source.aliases.length ? ` · also: ${source.aliases.join(', ')}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="secondary"
                  aria-label={`Edit ${source.name}`}
                  icon={<Pencil className="h-4 w-4" aria-hidden="true" />}
                  onClick={() => setEditing(source)}
                />
                <Button
                  variant="secondary"
                  aria-label={`Remove ${source.name}`}
                  icon={<Trash2 className="h-4 w-4" aria-hidden="true" />}
                  onClick={() => setRemoving(source)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <SourceDialog
          source={editing === 'new' ? null : editing}
          onClose={() => {
            setEditing(null)
          }}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title="Remove this source?"
        action="Remove source"
        onConfirm={() => (removing ? remove(removing) : Promise.resolve())}
        onClose={() => {
          setRemoving(null)
        }}
      >
        {removing?.name} can only be removed if no planting uses it.
      </ConfirmDialog>
    </>
  )
}

const schema = z.object({
  code: z.string().trim(),
  name: z.string().trim().min(1, 'Enter a name.'),
  aliases: z.string(),
})
type Values = z.infer<typeof schema>

function SourceDialog({ source, onClose }: { source: Source | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const notify = useToast()
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      code: source?.code ?? '',
      name: source?.name ?? '',
      aliases: source?.aliases.join('\n') ?? '',
    },
  })
  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    if (!source && !values.code) {
      setError('code', { message: 'Give the source a short code.' })
      return
    }
    const fields = { name: values.name, aliases: aliasesFromText(values.aliases) }
    try {
      if (source) {
        unwrap(
          await api.PATCH('/api/v1/admin/material-sources/{id}', {
            params: { path: { id: source.id } },
            body: fields,
          }),
        )
      } else {
        unwrap(
          await api.POST('/api/v1/admin/material-sources', {
            body: { ...fields, code: values.code },
          }),
        )
      }
      await queryClient.invalidateQueries({ queryKey: ['admin-sources'] })
      await queryClient.invalidateQueries({ queryKey: ['material-sources'] })
      notify('Saved.', 'success')
      onClose()
    } catch (err) {
      setFormError(applyServerErrors(err, setError, ['code', 'name', 'aliases']))
    }
  })
  return (
    <Dialog
      open
      onClose={onClose}
      title={source ? `Edit ${source.name}` : 'New source'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="source-form" loading={isSubmitting}>
            Save
          </Button>
        </>
      }
    >
      <form id="source-form" className="space-y-4" onSubmit={(e) => void onSubmit(e)} noValidate>
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <TextInput label="Name" required error={errors.name?.message} {...register('name')} />
        {source ? null : (
          <TextInput
            label="Code"
            required
            hint="It cannot change later."
            error={errors.code?.message}
            {...register('code')}
          />
        )}
        <TextArea
          label="Other spellings"
          hint={ALIASES_HINT}
          error={errors.aliases?.message}
          {...register('aliases')}
        />
      </form>
    </Dialog>
  )
}
