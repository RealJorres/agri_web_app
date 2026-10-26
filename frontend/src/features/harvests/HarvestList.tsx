import { zodResolver } from '@hookform/resolvers/zod'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'

import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Alert, Badge } from '@/components/ui/display'
import { Checkbox, SelectInput, TextInput } from '@/components/ui/fields'
import { useToast } from '@/components/ui/useToast'
import { useAuth } from '@/lib/auth/context'
import { applyServerErrors, errorMessage } from '@/lib/forms'
import { formatDate, formatNumber } from '@/lib/format'

import { useDeleteHarvest, useHarvests, useSaveHarvest, type Harvest } from './api'
import {
  FORM_LABELS,
  HARVEST_FIELDS,
  harvestSchema,
  toBody,
  toValues,
  UNIT_LABELS,
  type HarvestValues,
} from './schema'

/** Reported harvests of one crop stand (ADR-0018), with add/edit/delete for edit_records. */
export function HarvestList({ standId }: { standId: string }) {
  const { can } = useAuth()
  const harvests = useHarvests(standId)
  const [editing, setEditing] = useState<Harvest | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Harvest | null>(null)
  const canEdit = can('edit_records')

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold tracking-wide text-muted uppercase">Harvests</h4>
        {canEdit ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<Plus className="h-4 w-4" aria-hidden="true" />}
            onClick={() => setEditing('new')}
          >
            Add harvest
          </Button>
        ) : null}
      </div>
      {harvests.isPending ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : harvests.isError ? (
        <Alert tone="error">{errorMessage(harvests.error)}</Alert>
      ) : harvests.data.length === 0 ? (
        <p className="text-sm text-muted">No harvests reported.</p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {harvests.data.map((h) => (
            <li key={h.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
              <div>
                <p className="font-medium tabular-nums">
                  {formatNumber(h.quantity)} {UNIT_LABELS[h.unit]}
                  <span className="font-normal text-muted">
                    {' '}
                    · {FORM_LABELS[h.product_form ?? 'unknown']}
                  </span>
                </p>
                <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                  {h.harvest_date ? formatDate(h.harvest_date) : 'Date not recorded'}
                  {h.date_estimated ? <Badge tone="amber">Date estimated</Badge> : null}
                  {h.price_per_unit ? (
                    <span>
                      · ₱{formatNumber(h.price_per_unit)} per {UNIT_LABELS[h.unit]}
                    </span>
                  ) : null}
                  {h.buyer ? <span>· sold to {h.buyer}</span> : null}
                </p>
                {h.raw_text ? (
                  <p className="text-xs text-muted">Recorded as: “{h.raw_text}”</p>
                ) : null}
              </div>
              {canEdit ? (
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Edit harvest of ${formatNumber(h.quantity)} ${UNIT_LABELS[h.unit]}`}
                    icon={<Pencil className="h-4 w-4" aria-hidden="true" />}
                    onClick={() => setEditing(h)}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Delete harvest of ${formatNumber(h.quantity)} ${UNIT_LABELS[h.unit]}`}
                    icon={<Trash2 className="h-4 w-4" aria-hidden="true" />}
                    onClick={() => setDeleting(h)}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <HarvestDialog
          standId={standId}
          harvest={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {deleting ? (
        <DeleteDialog standId={standId} harvest={deleting} onClose={() => setDeleting(null)} />
      ) : null}
    </div>
  )
}

function HarvestDialog({
  standId,
  harvest,
  onClose,
}: {
  standId: string
  harvest: Harvest | undefined
  onClose: () => void
}) {
  const notify = useToast()
  const save = useSaveHarvest(standId)
  const [error, setError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    control,
    setError: setFieldError,
    formState: { errors },
  } = useForm<HarvestValues>({
    resolver: zodResolver(harvestSchema),
    defaultValues: toValues(harvest),
  })
  const dated = Boolean(useWatch({ control, name: 'harvest_date' }))

  const onSubmit = handleSubmit(async (values) => {
    setError(null)
    try {
      await save.mutateAsync({ id: harvest?.id, body: toBody(values) })
      notify(harvest ? 'Harvest updated.' : 'Harvest added.')
      onClose()
    } catch (err) {
      setError(applyServerErrors(err, setFieldError, HARVEST_FIELDS))
    }
  })

  return (
    <Dialog
      open
      onClose={onClose}
      title={harvest ? 'Edit harvest' : 'Add harvest'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="harvest-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="harvest-form" className="space-y-4" onSubmit={(e) => void onSubmit(e)} noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextInput
            label="Quantity"
            required
            inputMode="decimal"
            error={errors.quantity?.message}
            {...register('quantity')}
          />
          <SelectInput label="Unit" required error={errors.unit?.message} {...register('unit')}>
            <option value="kg">kg</option>
            <option value="sack">sack</option>
            <option value="other">other unit</option>
          </SelectInput>
        </div>
        <SelectInput
          label="Product"
          error={errors.product_form?.message}
          {...register('product_form')}
        >
          {Object.entries(FORM_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectInput>
        <TextInput
          label="Harvest date"
          type="date"
          hint="Leave empty if the farmer does not remember; it is then marked as estimated."
          error={errors.harvest_date?.message}
          {...register('harvest_date')}
        />
        {dated ? (
          <Checkbox label="The date is approximate" {...register('date_estimated')} />
        ) : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextInput
            label="Price per unit (₱)"
            inputMode="decimal"
            error={errors.price_per_unit?.message}
            {...register('price_per_unit')}
          />
          <TextInput label="Buyer" error={errors.buyer?.message} {...register('buyer')} />
        </div>
      </form>
    </Dialog>
  )
}

function DeleteDialog({
  standId,
  harvest,
  onClose,
}: {
  standId: string
  harvest: Harvest
  onClose: () => void
}) {
  const notify = useToast()
  const remove = useDeleteHarvest(standId)
  return (
    <Dialog
      open
      onClose={onClose}
      title="Delete this harvest?"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(harvest.id, {
                onSuccess: () => {
                  notify('Harvest deleted.')
                  onClose()
                },
              })
            }
          >
            Delete
          </Button>
        </>
      }
    >
      <p className="text-sm">
        {formatNumber(harvest.quantity)} {UNIT_LABELS[harvest.unit]} of{' '}
        {FORM_LABELS[harvest.product_form ?? 'unknown'].toLowerCase()} will be removed from the
        summaries. The deletion is recorded in the audit log.
      </p>
      {remove.isError ? (
        <div className="mt-3">
          <Alert tone="error">{errorMessage(remove.error)}</Alert>
        </div>
      ) : null}
    </Dialog>
  )
}
