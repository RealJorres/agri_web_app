import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, Layers, Plus } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link, useNavigate } from 'react-router'
import { z } from 'zod'

import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import {
  Alert,
  Badge,
  EmptyState,
  IconTile,
  PageHeader,
  StatusBadge,
} from '@/components/ui/display'
import { SelectInput, TextInput } from '@/components/ui/fields'
import { LoadingBlock } from '@/components/ui/Spinner'
import { api, unwrap } from '@/lib/api/client'
import { useAuth } from '@/lib/auth/context'
import { applyServerErrors, errorMessage } from '@/lib/forms'
import { formatDate } from '@/lib/format'
import { useCommodities, useRounds } from '@/lib/reference'

export default function RoundsPage() {
  const { can } = useAuth()
  const rounds = useRounds()
  const [creating, setCreating] = useState(false)
  return (
    <>
      <PageHeader
        title="Survey rounds"
        description="Inventory campaigns. Totals count approved records only."
        actions={
          can('manage_rounds') ? (
            <Button
              icon={<Plus className="h-4 w-4" aria-hidden="true" />}
              onClick={() => setCreating(true)}
            >
              New round
            </Button>
          ) : null
        }
      />
      {rounds.isPending ? (
        <LoadingBlock />
      ) : rounds.isError ? (
        <Alert tone="error">{errorMessage(rounds.error)}</Alert>
      ) : rounds.data.results.length === 0 ? (
        <EmptyState title="No survey rounds yet" icon={Layers} />
      ) : (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rounds.data.results.map((r) => (
            <li key={r.id}>
              <Link
                to={`/rounds/${r.id}`}
                className="surface-card group flex h-full flex-col gap-4 p-5 transition hover:-translate-y-0.5 hover:shadow-raised"
              >
                <span className="flex items-start justify-between gap-3">
                  <IconTile icon={Layers} />
                  <span className="flex flex-wrap justify-end gap-1.5">
                    {r.is_historical ? <Badge tone="amber">Historical</Badge> : null}
                    <StatusBadge status={r.status} />
                  </span>
                </span>
                <span className="min-w-0">
                  <span className="block font-display font-bold text-ink group-hover:text-brand-700">
                    {r.name}
                  </span>
                  <span className="mt-0.5 block text-[13px] text-muted">{r.commodity_name}</span>
                </span>
                <span className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-3 text-[13px] text-muted">
                  <span className="inline-flex items-center gap-1.5">
                    <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
                    as of {formatDate(r.as_of_date)}
                  </span>
                  {r.deadline ? <span>deadline {formatDate(r.deadline)}</span> : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <NewRoundDialog
        open={creating}
        onClose={() => {
          setCreating(false)
        }}
      />
    </>
  )
}

const schema = z.object({
  commodity: z.string().min(1, 'Choose a crop.'),
  name: z.string().trim().min(3, 'Give the round a name.'),
  as_of_date: z.string().min(1, 'Choose the as-of date.'),
  deadline: z.string(),
})
type Values = z.infer<typeof schema>

function NewRoundDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const commodities = useCommodities()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { commodity: '', name: '', as_of_date: '', deadline: '' },
  })
  const create = useMutation({
    mutationFn: async (v: Values) =>
      unwrap(
        await api.POST('/api/v1/survey-rounds', {
          body: {
            commodity: v.commodity,
            name: v.name,
            as_of_date: v.as_of_date,
            deadline: v.deadline || null,
          },
        }),
      ),
  })
  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    try {
      const round = await create.mutateAsync(values)
      await queryClient.invalidateQueries({ queryKey: ['survey-rounds'] })
      onClose()
      await navigate(`/rounds/${round.id}`)
    } catch (err) {
      setFormError(
        applyServerErrors(err, setError, ['commodity', 'name', 'as_of_date', 'deadline']),
      )
    }
  })
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New survey round"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="new-round" loading={create.isPending}>
            Open round
          </Button>
        </>
      }
    >
      <form id="new-round" className="space-y-4" onSubmit={(e) => void onSubmit(e)} noValidate>
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <SelectInput
          label="Crop"
          required
          error={errors.commodity?.message}
          {...register('commodity')}
        >
          <option value="">Choose…</option>
          {commodities.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectInput>
        <TextInput
          label="Name"
          required
          placeholder="Inventory - June 2026"
          error={errors.name?.message}
          {...register('name')}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextInput
            label="As of"
            type="date"
            required
            error={errors.as_of_date?.message}
            {...register('as_of_date')}
          />
          <TextInput
            label="Deadline"
            type="date"
            error={errors.deadline?.message}
            {...register('deadline')}
          />
        </div>
      </form>
    </Dialog>
  )
}
