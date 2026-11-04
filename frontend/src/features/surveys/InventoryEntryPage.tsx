import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type SyntheticEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'

import { Button } from '@/components/ui/Button'
import { Alert, Card, PageHeader, StatusBadge } from '@/components/ui/display'
import { SelectInput, TextArea } from '@/components/ui/fields'
import { LoadingBlock } from '@/components/ui/Spinner'
import { useToast } from '@/components/ui/useToast'
import { ApiError, api, unwrap, type Schemas } from '@/lib/api/client'
import { errorMessage } from '@/lib/forms'
import { formatNumber } from '@/lib/format'
import { useRounds } from '@/lib/reference'

import { useRecord, useStages, type InventoryRecord } from './api'
import { CommentHistory, RecordFlags, WorkflowActions } from './WorkflowActions'

type Stage = Schemas['GrowthStage']

export default function InventoryEntryPage() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const record = useRecord(id)
  const standId = id ? record.data?.crop_stand.id : (params.get('crop_stand') ?? undefined)
  const stand = useQuery({
    queryKey: ['crop-stand', standId],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/crop-stands/{id}', { params: { path: { id: standId ?? '' } } }),
      ),
    enabled: Boolean(standId),
  })
  if ((id && record.isPending) || (standId && stand.isPending)) return <LoadingBlock />
  if (record.isError) return <Alert tone="error">Record not found or not in your assignment.</Alert>
  if (!standId || stand.isError || !stand.data)
    return <Alert tone="error">Choose a crop stand from a farmer’s page first.</Alert>
  return (
    <InventoryForm
      key={
        record.data
          ? `${record.data.id}-${String(record.data.version)}-${record.data.status}`
          : 'new'
      }
      record={record.data}
      stand={stand.data}
    />
  )
}

function InventoryForm({
  record,
  stand,
}: {
  record?: InventoryRecord | undefined
  stand: Schemas['CropStand']
}) {
  const navigate = useNavigate()
  const notify = useToast()
  const queryClient = useQueryClient()
  const stages = useStages(stand.commodity.id)
  const openRounds = useRounds({ commodity: stand.commodity.id, status: 'open' })
  const editable = !record || record.allowed_actions.includes('edit')

  const initial: Record<string, string> = {}
  for (const c of record?.counts ?? []) {
    initial[c.growth_stage.id] = c.count === null || c.count === undefined ? '' : String(c.count)
  }
  const [counts, setCounts] = useState<Record<string, string>>(initial)
  const [remarks, setRemarks] = useState(record?.remarks ?? '')
  const [round, setRound] = useState(record?.survey_round.id ?? '')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: async () => {
      const payload = (stages.data ?? [])
        .filter((s) => (counts[s.id] ?? '') !== '')
        .map((s) => ({ growth_stage: s.id, count: Number(counts[s.id]) }))
      if (record) {
        return unwrap(
          await api.PATCH('/api/v1/inventory-records/{id}', {
            params: { path: { id: record.id } },
            body: { counts: payload, remarks },
          }),
        )
      }
      return unwrap(
        await api.POST('/api/v1/inventory-records', {
          body: {
            survey_round: round || (openRounds.data?.results[0]?.id ?? ''),
            crop_stand: stand.id,
            counts: payload,
            remarks,
          },
        }),
      )
    },
  })

  const validate = (list: Stage[]): boolean => {
    const next: Record<string, string> = {}
    for (const s of list) {
      const raw = (counts[s.id] ?? '').trim()
      if (raw !== '' && !/^\d+$/.test(raw)) next[s.id] = 'Whole number, 0 or more.'
    }
    const any = list.some((s) => Number(counts[s.id] ?? 0) > 0)
    if (!any && !remarks.trim())
      next.form = 'Enter at least one count, or explain in the remarks why there is none.'
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const onSave = async (event: SyntheticEvent) => {
    event.preventDefault()
    setFormError(null)
    if (!validate(stages.data ?? [])) return
    try {
      const saved = await save.mutateAsync()
      queryClient.setQueryData(['inventory-record', saved.id], saved)
      await queryClient.invalidateQueries({ queryKey: ['inventory-records'] })
      notify('Draft saved.')
      if (!record) await navigate(`/inventory/${saved.id}`, { replace: true })
    } catch (err) {
      setFormError(err instanceof ApiError ? errorMessage(err) : 'Could not save.')
    }
  }

  const total = (stages.data ?? []).reduce((sum, s) => sum + (Number(counts[s.id]) || 0), 0)
  const noRound = !record && openRounds.data?.results.length === 0

  return (
    <>
      <PageHeader
        title={
          record
            ? `${record.crop_stand.commodity_name} inventory`
            : `Record ${stand.commodity.name} inventory`
        }
        description={
          record ? (
            <>
              <Link to={`/farmers/${record.farmer.id}`} className="text-brand-800 hover:underline">
                {record.farmer.display_name}
              </Link>{' '}
              · {record.farm.barangay}, {record.farm.municipality} · {record.survey_round.name} ·
              version {record.version}
            </>
          ) : undefined
        }
        actions={record ? <StatusBadge status={record.status} /> : null}
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <form onSubmit={(e) => void onSave(e)} noValidate className="space-y-6 lg:col-span-2">
          {formError ? <Alert tone="error">{formError}</Alert> : null}
          {noRound ? (
            <Alert tone="warning">
              There is no open survey round for this crop. Ask the program coordinator to open one.
            </Alert>
          ) : null}
          {!record ? (
            <Card title="Survey round">
              <SelectInput
                label="Round"
                required
                value={round}
                onChange={(e) => setRound(e.target.value)}
              >
                {openRounds.data?.results.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </SelectInput>
            </Card>
          ) : null}
          <Card title="Trees by growth stage">
            {stages.isPending ? (
              <LoadingBlock />
            ) : (
              <fieldset disabled={!editable} className="space-y-4">
                <legend className="sr-only">Stage counts</legend>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  {stages.data?.map((s) => (
                    <div key={s.id} className="space-y-1">
                      <label htmlFor={`stage-${s.id}`} className="block text-sm font-medium">
                        {s.label}
                      </label>
                      <input
                        id={`stage-${s.id}`}
                        inputMode="numeric"
                        value={counts[s.id] ?? ''}
                        onChange={(e) => {
                          setCounts({ ...counts, [s.id]: e.target.value })
                        }}
                        aria-invalid={Boolean(errors[s.id])}
                        aria-describedby={errors[s.id] ? `stage-${s.id}-error` : undefined}
                        className="block w-full rounded-md border border-line-strong px-3 py-2 text-right text-sm tabular-nums aria-[invalid=true]:border-red-700 disabled:bg-sunken"
                      />
                      {errors[s.id] ? (
                        <p id={`stage-${s.id}-error`} className="text-xs font-medium text-red-700">
                          {errors[s.id]}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
                <p className="text-sm text-muted">
                  Total: <span className="font-semibold text-ink">{formatNumber(total)}</span> trees
                </p>
                {errors.form ? <Alert tone="error">{errors.form}</Alert> : null}
                <TextArea
                  label="Remarks"
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                />
              </fieldset>
            )}
          </Card>
          {editable ? (
            <div className="flex justify-end">
              <Button
                type="submit"
                variant={record ? 'secondary' : 'primary'}
                loading={save.isPending}
                disabled={noRound}
              >
                {record ? 'Save changes' : 'Save draft'}
              </Button>
            </div>
          ) : null}
        </form>
        {record ? (
          <div className="space-y-6">
            <RecordFlags record={record} />
            <Card title="Workflow">
              <WorkflowActions
                record={record}
                onDone={(updated) => {
                  queryClient.setQueryData(['inventory-record', updated.id], updated)
                }}
              />
              {record.allowed_actions.filter((a) => a !== 'edit').length === 0 ? (
                <p className="text-sm text-muted">No actions available for you at this stage.</p>
              ) : null}
            </Card>
            <Card title="Comments">
              <CommentHistory recordId={record.id} />
            </Card>
          </div>
        ) : null}
      </div>
    </>
  )
}
