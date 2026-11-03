import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link, useParams } from 'react-router'
import { z } from 'zod'

import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Alert, Badge, Card, EmptyState, PageHeader } from '@/components/ui/display'
import { Checkbox, SelectInput, TextArea, TextInput } from '@/components/ui/fields'
import { LoadingBlock } from '@/components/ui/Spinner'
import { useToast } from '@/components/ui/useToast'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { applyServerErrors, errorMessage } from '@/lib/forms'

import { aliasesFromText, ALIASES_HINT, MEASURE_LABELS, usePrograms } from './catalog'
import { ConfirmDialog } from './shared'

type Crop = Schemas['Commodity']
type Stage = Schemas['AdminGrowthStage']
type Variety = Schemas['AdminVariety']

export default function CropDetailPage() {
  const { id = '' } = useParams()
  const crop = useQuery({
    queryKey: ['commodities', id],
    queryFn: async () =>
      unwrap(await api.GET('/api/v1/commodities/{id}', { params: { path: { id } } })),
  })
  if (crop.isPending) return <LoadingBlock />
  if (crop.isError) return <Alert tone="error">{errorMessage(crop.error)}</Alert>
  return (
    <>
      <p className="mb-2 text-sm">
        <Link to="/admin/crops" className="text-brand-800 hover:underline">
          ← Crops
        </Link>
      </p>
      <PageHeader title={crop.data.name} description={`Code ${crop.data.code}`} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SettingsCard key={crop.data.id} crop={crop.data} />
        <div className="space-y-6">
          <StagesCard crop={crop.data} />
          <VarietiesCard crop={crop.data} />
        </div>
      </div>
    </>
  )
}

const settingsSchema = z.object({
  program: z.string().min(1, 'Choose a program.'),
  name: z.string().trim().min(1, 'Give the crop a name.'),
  measure_type: z.enum(['trees', 'area']),
  plants_per_ha: z.string().trim(),
  spacing_m: z.string().trim(),
  outlier_multiplier: z.string().trim().min(1, 'Enter a number.'),
  attributes_schema: z.string().trim(),
})
type SettingsValues = z.infer<typeof settingsSchema>

function SettingsCard({ crop }: { crop: Crop }) {
  const queryClient = useQueryClient()
  const notify = useToast()
  const programs = usePrograms()
  const usage = useQuery({
    queryKey: ['commodity-usage', crop.id],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/admin/commodities/{id}/usage', {
          params: { path: { id: crop.id } },
        }),
      ),
  })
  const inUse = usage.data ? usage.data.crop_stands > 0 || usage.data.rounds > 0 : true
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<SettingsValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      program: crop.program.id,
      name: crop.name,
      measure_type: crop.measure_type,
      plants_per_ha: crop.plants_per_ha === null ? '' : String(crop.plants_per_ha ?? ''),
      spacing_m: crop.spacing_m ?? '',
      outlier_multiplier: crop.outlier_multiplier ?? '5',
      attributes_schema: JSON.stringify(crop.attributes_schema ?? {}, null, 2),
    },
  })
  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    let attributes: Record<string, unknown>
    try {
      attributes = JSON.parse(values.attributes_schema || '{}') as Record<string, unknown>
    } catch {
      setError('attributes_schema', { message: 'This is not valid JSON.' })
      return
    }
    try {
      unwrap(
        await api.PATCH('/api/v1/admin/commodities/{id}', {
          params: { path: { id: crop.id } },
          body: {
            name: values.name,
            // Left out once in use: the server refuses a change, and these are read-only then.
            ...(inUse ? {} : { program: values.program, measure_type: values.measure_type }),
            plants_per_ha: values.plants_per_ha ? Number(values.plants_per_ha) : null,
            spacing_m: values.spacing_m || null,
            outlier_multiplier: values.outlier_multiplier,
            attributes_schema: attributes,
          },
        }),
      )
      await queryClient.invalidateQueries({ queryKey: ['commodities'] })
      notify('Saved.', 'success')
    } catch (err) {
      setFormError(
        applyServerErrors(err, setError, [
          'program',
          'name',
          'measure_type',
          'plants_per_ha',
          'spacing_m',
          'outlier_multiplier',
          'attributes_schema',
        ]),
      )
    }
  })
  return (
    <Card title="Settings">
      <form className="space-y-4" onSubmit={(e) => void onSubmit(e)} noValidate>
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        {usage.data && inUse ? (
          <Alert>
            In use by {usage.data.crop_stands} crop stands and {usage.data.rounds} survey rounds, so
            its program and how it is measured can no longer change.
          </Alert>
        ) : null}
        <TextInput label="Name" required error={errors.name?.message} {...register('name')} />
        <SelectInput
          label="Program"
          required
          disabled={inUse}
          error={errors.program?.message}
          {...register('program')}
        >
          {/* Keeps the current value selectable while the list of programs loads. */}
          {programs.data ? null : <option value={crop.program.id}>{crop.program.name}</option>}
          {programs.data?.map((program) => (
            <option key={program.id} value={program.id}>
              {program.name}
            </option>
          ))}
        </SelectInput>
        <SelectInput
          label="How it is measured"
          required
          disabled={inUse}
          error={errors.measure_type?.message}
          {...register('measure_type')}
        >
          {Object.entries(MEASURE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectInput>
        <TextInput
          label="Plants per hectare"
          inputMode="numeric"
          hint="Changing this changes every area worked out from tree counts, including past rounds."
          error={errors.plants_per_ha?.message}
          {...register('plants_per_ha')}
        />
        <TextInput
          label="Standard spacing (m)"
          inputMode="decimal"
          error={errors.spacing_m?.message}
          {...register('spacing_m')}
        />
        <TextInput
          label="Outlier multiplier"
          inputMode="decimal"
          hint="A count this many times above normal is flagged for checking."
          error={errors.outlier_multiplier?.message}
          {...register('outlier_multiplier')}
        />
        <TextArea
          label="Crop attributes (advanced)"
          hint="A JSON Schema for extra details recorded on each crop stand. Leave as {} if none."
          error={errors.attributes_schema?.message}
          {...register('attributes_schema')}
        />
        <Button type="submit" loading={isSubmitting}>
          Save
        </Button>
      </form>
    </Card>
  )
}

function StagesCard({ crop }: { crop: Crop }) {
  const queryClient = useQueryClient()
  const notify = useToast()
  const [editing, setEditing] = useState<Stage | 'new' | null>(null)
  const [removing, setRemoving] = useState<Stage | null>(null)
  const stages = useQuery({
    queryKey: ['admin-stages', crop.id],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/admin/commodities/{id}/stages', {
          params: { path: { id: crop.id } },
        }),
      ),
  })
  const remove = async (stage: Stage) => {
    unwrap(await api.DELETE('/api/v1/admin/stages/{id}', { params: { path: { id: stage.id } } }))
    await queryClient.invalidateQueries({ queryKey: ['admin-stages', crop.id] })
    await queryClient.invalidateQueries({ queryKey: ['commodities'] })
    notify('Stage removed.', 'success')
  }
  const rows = stages.data ?? []
  return (
    <Card
      title="Growth stages"
      actions={
        <Button
          variant="secondary"
          icon={<Plus className="h-4 w-4" aria-hidden="true" />}
          onClick={() => setEditing('new')}
        >
          Add stage
        </Button>
      }
    >
      {stages.isError ? <Alert tone="error">{errorMessage(stages.error)}</Alert> : null}
      {stages.isPending ? <LoadingBlock /> : null}
      {stages.data?.length === 0 ? (
        <EmptyState title="No stages yet">
          Records and workbooks need at least one, and they appear on reports in this order.
        </EmptyState>
      ) : null}
      <ul className="divide-y divide-line">
        {rows.map((stage) => (
          <li key={stage.id} className="flex items-start justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="font-medium">
                {stage.sort_order}. {stage.label}{' '}
                {stage.is_bearing ? <Badge tone="green">Bearing</Badge> : null}
              </p>
              <p className="text-xs text-muted">
                {stage.code}
                {stage.aliases.length ? ` · also: ${stage.aliases.join(', ')}` : ''}
              </p>
            </div>
            <RowActions
              name={stage.label}
              onEdit={() => setEditing(stage)}
              onRemove={() => setRemoving(stage)}
            />
          </li>
        ))}
      </ul>
      {editing ? (
        <StageDialog
          crop={crop}
          stage={editing === 'new' ? null : editing}
          nextOrder={(rows.at(-1)?.sort_order ?? 0) + 1}
          onClose={() => {
            setEditing(null)
          }}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title="Remove this stage?"
        action="Remove stage"
        onConfirm={() => (removing ? remove(removing) : Promise.resolve())}
        onClose={() => {
          setRemoving(null)
        }}
      >
        {removing?.label} can only be removed if no record uses it.
      </ConfirmDialog>
    </Card>
  )
}

function RowActions({
  name,
  onEdit,
  onRemove,
}: {
  name: string
  onEdit: () => void
  onRemove: () => void
}) {
  return (
    <div className="flex shrink-0 gap-2">
      <Button
        variant="secondary"
        aria-label={`Edit ${name}`}
        icon={<Pencil className="h-4 w-4" aria-hidden="true" />}
        onClick={onEdit}
      />
      <Button
        variant="secondary"
        aria-label={`Remove ${name}`}
        icon={<Trash2 className="h-4 w-4" aria-hidden="true" />}
        onClick={onRemove}
      />
    </div>
  )
}

const stageSchema = z.object({
  code: z.string().trim(),
  label: z.string().trim().min(1, 'Give the stage a name.'),
  sort_order: z.string().trim().regex(/^\d+$/u, 'Enter a whole number.'),
  is_bearing: z.boolean(),
  aliases: z.string(),
})
type StageValues = z.infer<typeof stageSchema>

function StageDialog({
  crop,
  stage,
  nextOrder,
  onClose,
}: {
  crop: Crop
  stage: Stage | null
  nextOrder: number
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const notify = useToast()
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<StageValues>({
    resolver: zodResolver(stageSchema),
    defaultValues: {
      code: stage?.code ?? '',
      label: stage?.label ?? '',
      sort_order: String(stage?.sort_order ?? nextOrder),
      is_bearing: stage?.is_bearing ?? false,
      aliases: stage?.aliases.join('\n') ?? '',
    },
  })
  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    if (!stage && !values.code) {
      setError('code', { message: 'Give the stage a short code.' })
      return
    }
    const fields = {
      label: values.label,
      sort_order: Number(values.sort_order),
      is_bearing: values.is_bearing,
      aliases: aliasesFromText(values.aliases),
    }
    try {
      if (stage) {
        unwrap(
          await api.PATCH('/api/v1/admin/stages/{id}', {
            params: { path: { id: stage.id } },
            body: fields,
          }),
        )
      } else {
        unwrap(
          await api.POST('/api/v1/admin/commodities/{id}/stages', {
            params: { path: { id: crop.id } },
            body: { ...fields, code: values.code },
          }),
        )
      }
      await queryClient.invalidateQueries({ queryKey: ['admin-stages', crop.id] })
      await queryClient.invalidateQueries({ queryKey: ['commodities'] })
      notify('Saved.', 'success')
      onClose()
    } catch (err) {
      setFormError(
        applyServerErrors(err, setError, ['code', 'label', 'sort_order', 'is_bearing', 'aliases']),
      )
    }
  })
  return (
    <Dialog
      open
      onClose={onClose}
      title={stage ? `Edit ${stage.label}` : 'Add stage'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="stage-form" loading={isSubmitting}>
            Save
          </Button>
        </>
      }
    >
      <form id="stage-form" className="space-y-4" onSubmit={(e) => void onSubmit(e)} noValidate>
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <TextInput label="Name" required error={errors.label?.message} {...register('label')} />
        {stage ? null : (
          <TextInput
            label="Code"
            required
            hint="It cannot change later."
            error={errors.code?.message}
            {...register('code')}
          />
        )}
        <TextInput
          label="Position"
          required
          inputMode="numeric"
          hint="Stages appear on forms and reports in this order."
          error={errors.sort_order?.message}
          {...register('sort_order')}
        />
        <Checkbox
          label="This stage bears fruit (counts toward the bearing share)"
          error={errors.is_bearing?.message}
          {...register('is_bearing')}
        />
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

function VarietiesCard({ crop }: { crop: Crop }) {
  const queryClient = useQueryClient()
  const notify = useToast()
  const [editing, setEditing] = useState<Variety | 'new' | null>(null)
  const [removing, setRemoving] = useState<Variety | null>(null)
  const varieties = useQuery({
    queryKey: ['admin-varieties', crop.id],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/admin/varieties', { params: { query: { commodity: crop.id } } }),
      ),
  })
  const remove = async (variety: Variety) => {
    unwrap(
      await api.DELETE('/api/v1/admin/varieties/{id}', { params: { path: { id: variety.id } } }),
    )
    await queryClient.invalidateQueries({ queryKey: ['admin-varieties', crop.id] })
    notify('Variety removed.', 'success')
  }
  return (
    <Card
      title="Varieties"
      actions={
        <Button
          variant="secondary"
          icon={<Plus className="h-4 w-4" aria-hidden="true" />}
          onClick={() => setEditing('new')}
        >
          Add variety
        </Button>
      }
    >
      {varieties.isError ? <Alert tone="error">{errorMessage(varieties.error)}</Alert> : null}
      {varieties.isPending ? <LoadingBlock /> : null}
      {varieties.data?.length === 0 ? <EmptyState title="No varieties yet" /> : null}
      <ul className="divide-y divide-line">
        {varieties.data?.map((variety) => (
          <li key={variety.id} className="flex items-start justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="font-medium">{variety.name}</p>
              <p className="text-xs text-muted">
                {variety.code}
                {variety.aliases.length ? ` · also: ${variety.aliases.join(', ')}` : ''}
              </p>
            </div>
            <RowActions
              name={variety.name}
              onEdit={() => setEditing(variety)}
              onRemove={() => setRemoving(variety)}
            />
          </li>
        ))}
      </ul>
      {editing ? (
        <VarietyDialog
          crop={crop}
          variety={editing === 'new' ? null : editing}
          onClose={() => {
            setEditing(null)
          }}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title="Remove this variety?"
        action="Remove variety"
        onConfirm={() => (removing ? remove(removing) : Promise.resolve())}
        onClose={() => {
          setRemoving(null)
        }}
      >
        {removing?.name} can only be removed if no planting uses it.
      </ConfirmDialog>
    </Card>
  )
}

const namedSchema = z.object({
  code: z.string().trim(),
  name: z.string().trim().min(1, 'Enter a name.'),
  aliases: z.string(),
})
type NamedValues = z.infer<typeof namedSchema>

function VarietyDialog({
  crop,
  variety,
  onClose,
}: {
  crop: Crop
  variety: Variety | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const notify = useToast()
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<NamedValues>({
    resolver: zodResolver(namedSchema),
    defaultValues: {
      code: variety?.code ?? '',
      name: variety?.name ?? '',
      aliases: variety?.aliases.join('\n') ?? '',
    },
  })
  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    if (!variety && !values.code) {
      setError('code', { message: 'Give the variety a short code.' })
      return
    }
    const fields = { name: values.name, aliases: aliasesFromText(values.aliases) }
    try {
      if (variety) {
        unwrap(
          await api.PATCH('/api/v1/admin/varieties/{id}', {
            params: { path: { id: variety.id } },
            body: fields,
          }),
        )
      } else {
        unwrap(
          await api.POST('/api/v1/admin/varieties', {
            body: { ...fields, commodity: crop.id, code: values.code },
          }),
        )
      }
      await queryClient.invalidateQueries({ queryKey: ['admin-varieties', crop.id] })
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
      title={variety ? `Edit ${variety.name}` : 'Add variety'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="variety-form" loading={isSubmitting}>
            Save
          </Button>
        </>
      }
    >
      <form id="variety-form" className="space-y-4" onSubmit={(e) => void onSubmit(e)} noValidate>
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <TextInput label="Name" required error={errors.name?.message} {...register('name')} />
        {variety ? null : (
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
