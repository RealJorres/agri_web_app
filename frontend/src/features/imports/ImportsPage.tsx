import { useMutation, useQuery } from '@tanstack/react-query'
import { Download, Upload } from 'lucide-react'
import { useState, type SyntheticEvent } from 'react'
import { Link, useNavigate } from 'react-router'

import { Button } from '@/components/ui/Button'
import { Alert, Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui/display'
import { SelectInput, TextInput } from '@/components/ui/fields'
import { LoadingBlock } from '@/components/ui/Spinner'
import { useToast } from '@/components/ui/useToast'
import { ApiError, authFetch, download, unwrap, api, type Schemas } from '@/lib/api/client'
import { errorMessage } from '@/lib/forms'
import { formatDateTime } from '@/lib/format'
import { useCommodities, useRounds } from '@/lib/reference'

type Kind = Schemas['ImportKindEnum']
const KINDS: { value: Kind; label: string; hint: string }[] = [
  {
    value: 'template',
    label: 'Clean template',
    hint: 'One row per farm, downloaded from this page.',
  },
  {
    value: 'legacy_workbook',
    label: 'Existing crop workbook',
    hint: 'A filled workbook with one sheet per municipality. Its records are approved as historical data in a new survey round.',
  },
]
// Past jobs can still be of a kind no longer offered for upload.
const KIND_LABELS: Partial<Record<Kind, string>> = {
  legacy_cacao_2023: 'Legacy workbook (2023)',
  ...Object.fromEntries(KINDS.map((kind) => [kind.value, kind.label])),
}

export default function ImportsPage() {
  const jobs = useQuery({
    queryKey: ['imports'],
    queryFn: async () => unwrap(await api.GET('/api/v1/imports')),
  })
  return (
    <>
      <PageHeader
        title="Imports"
        description="Upload a workbook, review the preview, then commit."
        actions={
          <Link
            to="/inventory/entry"
            className="inline-flex min-h-10 items-center rounded-lg bg-surface px-4 py-2 text-sm font-semibold text-ink shadow-sm ring-1 ring-line-strong transition ring-inset hover:bg-sunken"
          >
            Enter one record instead
          </Link>
        }
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6">
          <UploadCard />
          <TemplateCard />
        </div>
        <Card title="Recent imports" className="lg:col-span-2">
          {jobs.isPending ? (
            <LoadingBlock />
          ) : jobs.isError ? (
            <Alert tone="error">{errorMessage(jobs.error)}</Alert>
          ) : jobs.data.results.length === 0 ? (
            <EmptyState title="No imports yet" />
          ) : (
            <ul className="divide-y divide-line">
              {jobs.data.results.map((j) => (
                <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <Link
                      to={`/imports/${j.id}`}
                      className="font-medium text-brand-800 hover:underline"
                    >
                      {j.original_name}
                    </Link>
                    <p className="text-xs text-muted">
                      {KIND_LABELS[j.kind]} · {j.uploaded_by} · {formatDateTime(j.created_at)}
                    </p>
                  </div>
                  <StatusBadge status={j.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  )
}

function UploadCard() {
  const navigate = useNavigate()
  const notify = useToast()
  const [kind, setKind] = useState<Kind>('template')
  const [round, setRound] = useState('')
  const [crop, setCrop] = useState('')
  const [roundName, setRoundName] = useState('')
  const [asOf, setAsOf] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rounds = useRounds({ status: 'open' })
  const commodities = useCommodities()
  // The workbook layout holds tree counts, so only tree crops can use it.
  const treeCrops = commodities.data?.filter((c) => c.measure_type === 'trees')
  const upload = useMutation({
    mutationFn: async () => {
      // Multipart upload: built by hand because openapi-fetch serialises JSON bodies.
      const form = new FormData()
      form.append('file', file as Blob)
      form.append('kind', kind)
      if (kind === 'template' && round) form.append('survey_round', round)
      if (kind === 'legacy_workbook') {
        form.append('commodity', crop)
        form.append('round_name', roundName)
        form.append('as_of_date', asOf)
      }
      const response = await authFetch(
        new Request('/api/v1/imports', { method: 'POST', body: form }),
      )
      const body = (await response.json()) as Schemas['ImportJob']
      if (!response.ok) throw new ApiError(response.status, body as never)
      return body
    },
  })
  const submit = async (event: SyntheticEvent) => {
    event.preventDefault()
    setError(null)
    if (!file) {
      setError('Choose a file to upload.')
      return
    }
    if (kind === 'legacy_workbook' && (!crop || !roundName.trim() || !asOf)) {
      setError('Choose the crop, and name the survey round and its as-of date.')
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('The file is larger than 10 MB.')
      return
    }
    try {
      const job = await upload.mutateAsync()
      notify('Uploaded. Checking the file…', 'info')
      await navigate(`/imports/${job.id}`)
    } catch (err) {
      setError(errorMessage(err))
    }
  }
  return (
    <Card title="Upload">
      <form className="space-y-4" onSubmit={(e) => void submit(e)} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Type of file</legend>
          {KINDS.map((k) => (
            <label key={k.value} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="kind"
                value={k.value}
                checked={kind === k.value}
                onChange={() => setKind(k.value)}
                className="mt-1 accent-brand-700"
              />
              <span>
                <span className="font-medium">{k.label}</span>
                <span className="block text-xs text-muted">{k.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {kind === 'template' ? (
          <SelectInput
            label="Load into round"
            required
            value={round}
            onChange={(e) => setRound(e.target.value)}
          >
            <option value="">Choose…</option>
            {rounds.data?.results.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </SelectInput>
        ) : null}
        {kind === 'legacy_workbook' ? (
          <>
            <SelectInput
              label="Crop"
              required
              value={crop}
              onChange={(e) => setCrop(e.target.value)}
            >
              <option value="">Choose…</option>
              {treeCrops?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </SelectInput>
            <TextInput
              label="New survey round"
              required
              placeholder="Inventory - July 2023"
              value={roundName}
              onChange={(e) => setRoundName(e.target.value)}
            />
            <TextInput
              label="As of"
              type="date"
              required
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
            />
          </>
        ) : null}
        <div className="space-y-1">
          <label htmlFor="import-file" className="block text-sm font-medium">
            File (.xlsx{kind === 'template' ? ' or .csv' : ''}, max 10 MB)
          </label>
          <input
            id="import-file"
            type="file"
            accept={kind === 'template' ? '.xlsx,.csv' : '.xlsx'}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-brand-800"
          />
        </div>
        <Button
          type="submit"
          icon={<Upload className="h-4 w-4" aria-hidden="true" />}
          loading={upload.isPending}
        >
          Upload and preview
        </Button>
      </form>
    </Card>
  )
}

function TemplateCard() {
  const commodities = useCommodities()
  const notify = useToast()
  const [commodity, setCommodity] = useState('')
  const chosen = commodity || commodities.data?.[0]?.id || ''
  return (
    <Card title="Blank template">
      <div className="space-y-3">
        <SelectInput label="Crop" value={chosen} onChange={(e) => setCommodity(e.target.value)}>
          {commodities.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectInput>
        <Button
          variant="secondary"
          icon={<Download className="h-4 w-4" aria-hidden="true" />}
          disabled={!chosen}
          onClick={() => {
            const name =
              commodities.data?.find((c) => c.id === chosen)?.code.toLowerCase() ?? 'crop'
            download(`/api/v1/imports/template?commodity=${chosen}`, `${name}-template.xlsx`).catch(
              (err: unknown) => {
                notify(errorMessage(err), 'error')
              },
            )
          }}
        >
          Download template
        </Button>
      </div>
    </Card>
  )
}
