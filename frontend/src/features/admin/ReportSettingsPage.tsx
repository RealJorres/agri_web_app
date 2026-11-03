import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2, Upload } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Alert, Card, EmptyState, PageHeader } from '@/components/ui/display'
import { SelectInput, TextArea, TextInput } from '@/components/ui/fields'
import { LoadingBlock } from '@/components/ui/Spinner'
import { useToast } from '@/components/ui/useToast'
import { api, ApiError, authFetch, unwrap, type ApiErrorBody, type Schemas } from '@/lib/api/client'
import { applyServerErrors, errorMessage } from '@/lib/forms'

import { ConfirmDialog } from './shared'

type Settings = Schemas['ReportSettings']
type Signatory = Schemas['Signatory']

const KEY = ['admin-report-settings']
const SIGNATORIES = ['admin-signatories']
const KIND_LABELS: Record<Signatory['report_kind'], string> = {
  summary: 'Summary report',
  municipal_list: 'Municipal list',
}

export default function ReportSettingsPage() {
  const settings = useQuery({
    queryKey: KEY,
    queryFn: async () => unwrap(await api.GET('/api/v1/admin/report-settings')),
  })
  return (
    <>
      <PageHeader
        title="Report settings"
        description="The letterhead, logo and signature blocks on official reports."
      />
      <div className="mb-6">
        <Alert tone="warning">
          These are part of each report. A change marks already signed reports as changed, and they
          need signing again.
        </Alert>
      </div>
      {settings.isPending ? (
        <LoadingBlock />
      ) : settings.isError ? (
        <Alert tone="error">{errorMessage(settings.error)}</Alert>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="space-y-6">
            <LetterheadCard settings={settings.data} />
            <LogoCard settings={settings.data} />
          </div>
          <SignatoriesCard />
        </div>
      )}
    </>
  )
}

const letterheadSchema = z.object({
  letterhead: z.string().trim().min(1, 'The letterhead cannot be empty.'),
  program_line: z.string().trim(),
})
type LetterheadValues = z.infer<typeof letterheadSchema>

function LetterheadCard({ settings }: { settings: Settings }) {
  const queryClient = useQueryClient()
  const notify = useToast()
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LetterheadValues>({
    resolver: zodResolver(letterheadSchema),
    defaultValues: { letterhead: settings.letterhead, program_line: settings.program_line },
  })
  const onSubmit = handleSubmit(async (body) => {
    setFormError(null)
    try {
      unwrap(await api.PATCH('/api/v1/admin/report-settings', { body }))
      await queryClient.invalidateQueries({ queryKey: KEY })
      notify('Saved.', 'success')
    } catch (err) {
      setFormError(applyServerErrors(err, setError, ['letterhead', 'program_line']))
    }
  })
  return (
    <Card title="Letterhead">
      <form className="space-y-4" onSubmit={(e) => void onSubmit(e)} noValidate>
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <TextArea
          label="Letterhead"
          required
          rows={5}
          hint="One line of the heading per line."
          error={errors.letterhead?.message}
          {...register('letterhead')}
        />
        <TextInput
          label="Program line"
          error={errors.program_line?.message}
          {...register('program_line')}
        />
        <Button type="submit" loading={isSubmitting}>
          Save
        </Button>
      </form>
    </Card>
  )
}

function LogoCard({ settings }: { settings: Settings }) {
  const queryClient = useQueryClient()
  const notify = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const upload = async () => {
    if (!file) {
      setError('Choose an image to upload.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      // Multipart upload: built by hand because openapi-fetch serialises JSON bodies.
      const form = new FormData()
      form.append('file', file)
      const response = await authFetch(
        new Request(`${globalThis.location.origin}/api/v1/admin/report-settings/logo`, {
          method: 'POST',
          body: form,
        }),
      )
      const body = (await response.json()) as Partial<ApiErrorBody>
      if (!response.ok) throw new ApiError(response.status, body)
      await queryClient.invalidateQueries({ queryKey: KEY })
      setFile(null)
      notify('Logo saved.', 'success')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    unwrap(await api.DELETE('/api/v1/admin/report-settings/logo'))
    await queryClient.invalidateQueries({ queryKey: KEY })
    notify('Logo removed.', 'success')
  }
  return (
    <Card title="Logo">
      <div className="space-y-3">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <p className="text-sm">
          {settings.has_logo ? 'A logo is set, and PDF reports show it.' : 'No logo is set.'}
        </p>
        <div className="space-y-1">
          <label htmlFor="logo-file" className="block text-sm font-medium">
            Image (PNG or JPEG, max 2 MB)
          </label>
          <input
            id="logo-file"
            type="file"
            accept=".png,.jpg,.jpeg"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-brand-800"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            icon={<Upload className="h-4 w-4" aria-hidden="true" />}
            loading={busy}
            onClick={() => void upload()}
          >
            Upload logo
          </Button>
          {settings.has_logo ? (
            <Button variant="secondary" onClick={() => setRemoving(true)}>
              Remove logo
            </Button>
          ) : null}
        </div>
      </div>
      <ConfirmDialog
        open={removing}
        title="Remove the logo?"
        action="Remove logo"
        onConfirm={remove}
        onClose={() => {
          setRemoving(false)
        }}
      >
        Reports will print without a logo until a new one is uploaded.
      </ConfirmDialog>
    </Card>
  )
}

function SignatoriesCard() {
  const queryClient = useQueryClient()
  const notify = useToast()
  const [editing, setEditing] = useState<Signatory | 'new' | null>(null)
  const [removing, setRemoving] = useState<Signatory | null>(null)
  const signatories = useQuery({
    queryKey: SIGNATORIES,
    queryFn: async () => unwrap(await api.GET('/api/v1/admin/signatories')),
  })
  const remove = async (row: Signatory) => {
    unwrap(await api.DELETE('/api/v1/admin/signatories/{id}', { params: { path: { id: row.id } } }))
    await queryClient.invalidateQueries({ queryKey: SIGNATORIES })
    notify('Signature block removed.', 'success')
  }
  return (
    <Card
      title="Signature blocks"
      actions={
        <Button
          variant="secondary"
          icon={<Plus className="h-4 w-4" aria-hidden="true" />}
          onClick={() => setEditing('new')}
        >
          Add
        </Button>
      }
    >
      {signatories.isError ? <Alert tone="error">{errorMessage(signatories.error)}</Alert> : null}
      {signatories.isPending ? <LoadingBlock /> : null}
      {signatories.data?.length === 0 ? <EmptyState title="No signature blocks yet" /> : null}
      <ul className="divide-y divide-line">
        {signatories.data?.map((row) => (
          <li key={row.id} className="flex items-start justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="text-xs text-muted">
                {KIND_LABELS[row.report_kind]} · position {row.order}
              </p>
              <p className="font-medium">{row.caption}</p>
              <p className="text-sm">
                {row.name}
                {row.title ? `, ${row.title}` : ''}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                variant="secondary"
                aria-label={`Edit ${row.caption} ${row.name}`}
                icon={<Pencil className="h-4 w-4" aria-hidden="true" />}
                onClick={() => setEditing(row)}
              />
              <Button
                variant="secondary"
                aria-label={`Remove ${row.caption} ${row.name}`}
                icon={<Trash2 className="h-4 w-4" aria-hidden="true" />}
                onClick={() => setRemoving(row)}
              />
            </div>
          </li>
        ))}
      </ul>
      {editing ? (
        <SignatoryDialog
          row={editing === 'new' ? null : editing}
          onClose={() => {
            setEditing(null)
          }}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title="Remove this signature block?"
        action="Remove"
        onConfirm={() => (removing ? remove(removing) : Promise.resolve())}
        onClose={() => {
          setRemoving(null)
        }}
      >
        {removing?.caption} {removing?.name} will no longer appear on this report.
      </ConfirmDialog>
    </Card>
  )
}

const signatorySchema = z.object({
  report_kind: z.enum(['summary', 'municipal_list']),
  order: z.string().trim().regex(/^\d+$/u, 'Enter a whole number.'),
  caption: z.string().trim().min(1, 'For example, Prepared by:'),
  name: z.string().trim().min(1, 'Enter the name to print.'),
  title: z.string().trim(),
})
type SignatoryValues = z.infer<typeof signatorySchema>

function SignatoryDialog({ row, onClose }: { row: Signatory | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const notify = useToast()
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<SignatoryValues>({
    resolver: zodResolver(signatorySchema),
    defaultValues: {
      report_kind: row?.report_kind ?? 'summary',
      order: String(row?.order ?? 1),
      caption: row?.caption ?? '',
      name: row?.name ?? '',
      title: row?.title ?? '',
    },
  })
  const onSubmit = handleSubmit(async ({ report_kind, order, ...values }) => {
    setFormError(null)
    const fields = { ...values, order: Number(order) }
    try {
      if (row) {
        unwrap(
          await api.PATCH('/api/v1/admin/signatories/{id}', {
            params: { path: { id: row.id } },
            body: fields,
          }),
        )
      } else {
        unwrap(await api.POST('/api/v1/admin/signatories', { body: { ...fields, report_kind } }))
      }
      await queryClient.invalidateQueries({ queryKey: SIGNATORIES })
      notify('Saved.', 'success')
      onClose()
    } catch (err) {
      setFormError(
        applyServerErrors(err, setError, ['report_kind', 'order', 'caption', 'name', 'title']),
      )
    }
  })
  return (
    <Dialog
      open
      onClose={onClose}
      title={row ? 'Edit signature block' : 'Add signature block'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="signatory-form" loading={isSubmitting}>
            Save
          </Button>
        </>
      }
    >
      <form id="signatory-form" className="space-y-4" onSubmit={(e) => void onSubmit(e)} noValidate>
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <SelectInput
          label="Report"
          required
          disabled={row !== null}
          error={errors.report_kind?.message}
          {...register('report_kind')}
        >
          {Object.entries(KIND_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectInput>
        <TextInput
          label="Position"
          required
          inputMode="numeric"
          error={errors.order?.message}
          {...register('order')}
        />
        <TextInput
          label="Caption"
          required
          placeholder="Prepared by:"
          error={errors.caption?.message}
          {...register('caption')}
        />
        <TextInput label="Name" required error={errors.name?.message} {...register('name')} />
        <TextInput label="Title" error={errors.title?.message} {...register('title')} />
      </form>
    </Dialog>
  )
}
