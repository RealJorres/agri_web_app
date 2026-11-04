import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { Link, useNavigate } from 'react-router'
import { z } from 'zod'

import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Alert, Badge, Card, EmptyState, PageHeader } from '@/components/ui/display'
import { SelectInput, TextInput } from '@/components/ui/fields'
import { LoadingBlock } from '@/components/ui/Spinner'
import { useToast } from '@/components/ui/useToast'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { applyServerErrors, errorMessage } from '@/lib/forms'
import { useCommodities } from '@/lib/reference'

import { MEASURE_LABELS, usePrograms } from './catalog'

export default function CropsPage() {
  const crops = useCommodities()
  const programs = usePrograms()
  const [creatingCrop, setCreatingCrop] = useState(false)
  const [editingProgram, setEditingProgram] = useState<Schemas['Program'] | 'new' | null>(null)
  return (
    <>
      <PageHeader
        title="Crops"
        description="A new crop is set up here, with no change to the system."
        actions={
          <Button
            icon={<Plus className="h-4 w-4" aria-hidden="true" />}
            disabled={!programs.data?.length}
            onClick={() => setCreatingCrop(true)}
          >
            New crop
          </Button>
        }
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {crops.isPending ? (
            <LoadingBlock />
          ) : crops.isError ? (
            <Alert tone="error">{errorMessage(crops.error)}</Alert>
          ) : crops.data.length === 0 ? (
            <EmptyState title="No crops yet" />
          ) : (
            <ul className="divide-y divide-line surface-card">
              {crops.data.map((crop) => (
                <li
                  key={crop.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div>
                    <Link
                      to={`/admin/crops/${crop.id}`}
                      className="font-medium text-brand-800 hover:underline"
                    >
                      {crop.name}
                    </Link>
                    <p className="text-sm text-muted">
                      {crop.program.name} · {MEASURE_LABELS[crop.measure_type]}
                    </p>
                  </div>
                  {crop.stages.length === 0 ? (
                    <Badge tone="amber">Needs growth stages</Badge>
                  ) : (
                    <Badge>{crop.stages.length} stages</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <Card
          title="Programs"
          actions={
            <Button variant="secondary" onClick={() => setEditingProgram('new')}>
              New program
            </Button>
          }
        >
          {programs.isError ? <Alert tone="error">{errorMessage(programs.error)}</Alert> : null}
          <ul className="divide-y divide-line">
            {programs.data?.map((program) => (
              <li key={program.id} className="flex items-center justify-between gap-2 py-2">
                <span className="text-sm">
                  <span className="font-medium">{program.code}</span>
                  <span className="block text-muted">{program.name}</span>
                </span>
                <Button variant="secondary" onClick={() => setEditingProgram(program)}>
                  Rename
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <NewCropDialog
        open={creatingCrop}
        programs={programs.data ?? []}
        onClose={() => {
          setCreatingCrop(false)
        }}
      />
      {editingProgram ? (
        <ProgramDialog
          program={editingProgram === 'new' ? null : editingProgram}
          onClose={() => {
            setEditingProgram(null)
          }}
        />
      ) : null}
    </>
  )
}

const cropSchema = z.object({
  program: z.string().min(1, 'Choose a program.'),
  code: z.string().trim().min(1, 'Give the crop a short code.'),
  name: z.string().trim().min(1, 'Give the crop a name.'),
  measure_type: z.enum(['trees', 'area']),
  plants_per_ha: z.string().trim(),
})
type CropValues = z.infer<typeof cropSchema>

function NewCropDialog({
  open,
  programs,
  onClose,
}: {
  open: boolean
  programs: Schemas['Program'][]
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setError,
    reset,
    control,
    formState: { errors, isSubmitting },
  } = useForm<CropValues>({
    resolver: zodResolver(cropSchema),
    defaultValues: { program: '', code: '', name: '', measure_type: 'trees', plants_per_ha: '' },
  })
  const measure = useWatch({ control, name: 'measure_type' })
  const onSubmit = handleSubmit(async ({ plants_per_ha, ...values }) => {
    setFormError(null)
    try {
      const crop = unwrap(
        await api.POST('/api/v1/admin/commodities', {
          body: { ...values, plants_per_ha: plants_per_ha ? Number(plants_per_ha) : null },
        }),
      )
      await queryClient.invalidateQueries({ queryKey: ['commodities'] })
      reset()
      onClose()
      await navigate(`/admin/crops/${crop.id}`)
    } catch (err) {
      setFormError(
        applyServerErrors(err, setError, [
          'program',
          'code',
          'name',
          'measure_type',
          'plants_per_ha',
        ]),
      )
    }
  })
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New crop"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="new-crop" loading={isSubmitting}>
            Create crop
          </Button>
        </>
      }
    >
      <form id="new-crop" className="space-y-4" onSubmit={(e) => void onSubmit(e)} noValidate>
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <SelectInput
          label="Program"
          required
          error={errors.program?.message}
          {...register('program')}
        >
          <option value="">Choose…</option>
          {programs.map((program) => (
            <option key={program.id} value={program.id}>
              {program.name}
            </option>
          ))}
        </SelectInput>
        <TextInput label="Name" required error={errors.name?.message} {...register('name')} />
        <TextInput
          label="Code"
          required
          hint="A short label such as COFFEE. It cannot change later."
          error={errors.code?.message}
          {...register('code')}
        />
        <SelectInput
          label="How it is measured"
          required
          error={errors.measure_type?.message}
          {...register('measure_type')}
        >
          {Object.entries(MEASURE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectInput>
        {measure === 'trees' ? (
          <TextInput
            label="Plants per hectare"
            inputMode="numeric"
            hint="Used to work out area from tree counts. Leave empty if there is no standard figure."
            error={errors.plants_per_ha?.message}
            {...register('plants_per_ha')}
          />
        ) : null}
      </form>
    </Dialog>
  )
}

const programSchema = z.object({
  code: z.string().trim(),
  name: z.string().trim().min(1, 'Give the program a name.'),
})
type ProgramValues = z.infer<typeof programSchema>

function ProgramDialog({
  program,
  onClose,
}: {
  program: Schemas['Program'] | null
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
  } = useForm<ProgramValues>({
    resolver: zodResolver(programSchema),
    defaultValues: { code: program?.code ?? '', name: program?.name ?? '' },
  })
  const onSubmit = handleSubmit(async ({ code, name }) => {
    setFormError(null)
    if (!program && !code) {
      setError('code', { message: 'Give the program a short code.' })
      return
    }
    try {
      if (program) {
        unwrap(
          await api.PATCH('/api/v1/admin/programs/{id}', {
            params: { path: { id: program.id } },
            body: { name },
          }),
        )
      } else {
        unwrap(await api.POST('/api/v1/admin/programs', { body: { code, name } }))
      }
      await queryClient.invalidateQueries({ queryKey: ['programs'] })
      await queryClient.invalidateQueries({ queryKey: ['commodities'] })
      notify('Saved.', 'success')
      onClose()
    } catch (err) {
      setFormError(applyServerErrors(err, setError, ['code', 'name']))
    }
  })
  return (
    <Dialog
      open
      onClose={onClose}
      title={program ? `Rename ${program.code}` : 'New program'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="program-form" loading={isSubmitting}>
            Save
          </Button>
        </>
      }
    >
      <form id="program-form" className="space-y-4" onSubmit={(e) => void onSubmit(e)} noValidate>
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        {program ? null : (
          <TextInput
            label="Code"
            required
            hint="It cannot change later."
            error={errors.code?.message}
            {...register('code')}
          />
        )}
        <TextInput label="Name" required error={errors.name?.message} {...register('name')} />
      </form>
    </Dialog>
  )
}
