import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { Search, UserCheck, UserPlus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { Link, useNavigate } from 'react-router'
import { z } from 'zod'

import { Button } from '@/components/ui/Button'
import { Alert, Avatar, Card, PageHeader } from '@/components/ui/display'
import { Checkbox, SelectInput, TextArea, TextInput } from '@/components/ui/fields'
import { useToast } from '@/components/ui/useToast'
import { useDuplicates, useFarmer, useFarmers } from '@/features/farmers/api'
import { PRIVACY_NOTICE, farmerSchema, optionalYear } from '@/features/farmers/schema'
import { ApiError, api, unwrap } from '@/lib/api/client'
import { useAuth } from '@/lib/auth/context'
import { applyServerErrors, errorMessage } from '@/lib/forms'
import { formatNumber } from '@/lib/format'
import {
  useBarangays,
  useMaterialSources,
  useMunicipalities,
  useRounds,
  useVarieties,
} from '@/lib/reference'
import { useDebounced } from '@/lib/useDebounced'

import { useStages, useTransition } from './api'

const { first_name, middle_name, last_name, suffix, sex, birth_year, rsbsa_no, contact_no } =
  farmerSchema.shape

const entrySchema = z
  .object({
    survey_round: z.string().min(1, 'Choose the survey round.'),
    farmer: z.string(),
    first_name,
    middle_name,
    last_name,
    suffix,
    sex,
    birth_year,
    rsbsa_no,
    contact_no,
    municipality: z.string(),
    home_barangay: z.string(),
    consent_given: z.boolean(),
    barangay: z.string(),
    sitio: z.string().trim().max(100),
    year_planted: optionalYear,
    variety: z.string(),
    source: z.string(),
    counts: z.record(z.string(), z.string()),
    remarks: z.string().trim().max(2000),
  })
  .superRefine((v, ctx) => {
    if (!v.farmer) {
      const required: [keyof typeof v, boolean, string][] = [
        ['last_name', Boolean(v.first_name || v.last_name), 'Enter the farmer’s name.'],
        ['municipality', Boolean(v.municipality), 'Choose the municipality.'],
        ['home_barangay', Boolean(v.home_barangay), 'Choose the home barangay.'],
        ['consent_given', v.consent_given, 'Read the notice to the farmer and record consent.'],
      ]
      for (const [field, ok, message] of required) {
        if (!ok) ctx.addIssue({ code: 'custom', path: [field], message })
      }
    }
    for (const [stage, raw] of Object.entries(v.counts)) {
      if (raw.trim() !== '' && !/^\d+$/.test(raw.trim())) {
        ctx.addIssue({
          code: 'custom',
          path: ['counts', stage],
          message: 'Whole number, 0 or more.',
        })
      }
    }
    const anyCount = Object.values(v.counts).some((raw) => Number(raw) > 0)
    if (!anyCount && !v.remarks) {
      ctx.addIssue({
        code: 'custom',
        path: ['remarks'],
        message: 'Enter at least one count, or explain here why there is none.',
      })
    }
  })
type Values = z.infer<typeof entrySchema>

const SERVER_FIELDS = [
  'survey_round',
  'first_name',
  'middle_name',
  'last_name',
  'suffix',
  'sex',
  'birth_year',
  'rsbsa_no',
  'contact_no',
  'home_barangay',
  'consent_given',
  'barangay',
  'sitio',
  'year_planted',
  'source',
  'remarks',
]

const EMPTY: Values = {
  survey_round: '',
  farmer: '',
  first_name: '',
  middle_name: '',
  last_name: '',
  suffix: '',
  sex: '',
  birth_year: '',
  rsbsa_no: '',
  contact_no: '',
  municipality: '',
  home_barangay: '',
  consent_given: false,
  barangay: '',
  sitio: '',
  year_planted: '',
  variety: '',
  source: '',
  counts: {},
  remarks: '',
}

/** Finds a registered farmer by name or RSBSA number. The API limits results to the assignment. */
function FarmerSearch({ onPick }: { onPick: (id: string) => void }) {
  const [text, setText] = useState('')
  const q = useDebounced(text.trim())
  const results = useFarmers(q.length >= 2 ? { q } : { q: '', page: 1 })
  const rows = q.length >= 2 ? (results.data?.results ?? []).slice(0, 6) : []
  return (
    <div className="space-y-2">
      <label htmlFor="entry-farmer-search" className="block text-[13px] font-semibold">
        Search registered farmers
      </label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-3 left-3 h-4 w-4 text-muted"
          aria-hidden="true"
        />
        <input
          id="entry-farmer-search"
          type="search"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
          }}
          placeholder="Name or RSBSA no."
          className="block min-h-10 w-full rounded-lg border border-line-strong bg-surface py-2 pr-3 pl-9 text-sm shadow-xs transition placeholder:text-muted hover:border-muted focus:border-brand-600 focus:ring-3 focus:ring-brand-600/15 focus:outline-none"
        />
      </div>
      {q.length >= 2 && !results.isPending && rows.length === 0 ? (
        <p className="text-sm text-muted">No farmer matches. Enter them as a new farmer.</p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="divide-y divide-line overflow-hidden rounded-xl ring-1 ring-line ring-inset">
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(row.id)
                }}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition hover:bg-brand-50"
              >
                <Avatar name={row.display_name} />
                <span className="min-w-0">
                  <span className="block font-semibold">{row.display_name}</span>
                  <span className="block text-xs text-muted">
                    {row.home_barangay.name}, {row.municipality.name}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export default function NewEntryPage() {
  const navigate = useNavigate()
  const notify = useToast()
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const transition = useTransition()
  const canSubmit = can('submit')
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [another, setAnother] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [saved, setSaved] = useState<{ id: string; name: string; submitted: boolean } | null>(null)
  const top = useRef<HTMLDivElement>(null)

  const {
    register,
    handleSubmit,
    setError,
    setValue,
    getValues,
    reset,
    control,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(entrySchema), defaultValues: EMPTY })

  const values = useWatch({ control })
  const rounds = useRounds({ status: 'open' })
  const openRounds = rounds.data?.results ?? []
  const firstRound = (openRounds.find((r) => !r.is_historical) ?? openRounds[0])?.id
  useEffect(() => {
    // The current round, once rounds have loaded, so most entries need no choice here.
    if (firstRound && !getValues('survey_round')) setValue('survey_round', firstRound)
  }, [firstRound, getValues, setValue])

  const round = openRounds.find((r) => r.id === values.survey_round)
  const stages = useStages(round?.commodity)
  const varieties = useVarieties(round?.commodity)
  const sources = useMaterialSources()
  const municipalities = useMunicipalities()
  const chosen = useFarmer(values.farmer || undefined)
  const farmer = values.farmer ? chosen.data : undefined
  const townId = farmer?.municipality.id ?? values.municipality ?? ''
  const homeBarangays = useBarangays(values.municipality || undefined)
  const farmBarangays = useBarangays(townId || undefined)

  const probeName = useDebounced(`${values.first_name ?? ''} ${values.last_name ?? ''}`.trim(), 400)
  const duplicates = useDuplicates({
    name: mode === 'new' ? probeName : '',
    ...(values.home_barangay ? { barangay: values.home_barangay } : {}),
  })
  const matches = mode === 'new' ? (duplicates.data ?? []) : []

  const pickFarmer = (id: string) => {
    setValue('farmer', id)
    setValue('barangay', '')
    setMode('existing')
  }
  const switchMode = (next: 'new' | 'existing') => {
    setValue('farmer', '')
    setValue('barangay', '')
    setMode(next)
  }

  const total = (stages.data ?? []).reduce(
    (sum, s) => sum + (Number(values.counts?.[s.id]) || 0),
    0,
  )

  const save = (thenSubmit: boolean) =>
    handleSubmit(async (v) => {
      setFormError(null)
      let id: string
      let name: string
      try {
        const record = unwrap(
          await api.POST('/api/v1/inventory-entries', {
            body: {
              survey_round: v.survey_round,
              ...(v.farmer
                ? { farmer: v.farmer }
                : {
                    new_farmer: {
                      first_name: v.first_name,
                      middle_name: v.middle_name,
                      last_name: v.last_name,
                      suffix: v.suffix,
                      sex: v.sex,
                      birth_year: v.birth_year ? Number(v.birth_year) : null,
                      rsbsa_no: v.rsbsa_no || null,
                      contact_no: v.contact_no,
                      home_barangay: v.home_barangay,
                      consent_given: v.consent_given,
                    },
                  }),
              ...(v.barangay ? { barangay: v.barangay } : {}),
              sitio: v.sitio,
              planting: {
                year_planted: v.year_planted ? Number(v.year_planted) : null,
                source: v.source || null,
                ...(v.variety ? { varieties: [v.variety] } : {}),
              },
              counts: (stages.data ?? [])
                .filter((s) => (v.counts[s.id] ?? '').trim() !== '')
                .map((s) => ({ growth_stage: s.id, count: Number(v.counts[s.id]) })),
              remarks: v.remarks,
            },
          }),
        )
        id = record.id
        name = record.farmer.display_name
      } catch (err) {
        setFormError(
          err instanceof ApiError && err.code === 'duplicate_record'
            ? 'This farm already has a record in this round. Open it from the farmer’s page to change it.'
            : applyServerErrors(err, setError, SERVER_FIELDS),
        )
        top.current?.scrollIntoView({ block: 'start' })
        return
      }
      await Promise.all(
        [['farmers'], ['inventory-records'], ['stats'], ['survey-round']].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      )

      let submitted = false
      if (thenSubmit) {
        try {
          await transition.mutateAsync({ id, action: 'submit', comment: '' })
          submitted = true
        } catch (err) {
          // The draft is safe. Its page shows what needs fixing before it can be submitted.
          notify(`Saved as a draft, not submitted. ${errorMessage(err)}`, 'error')
          await navigate(`/inventory/${id}`)
          return
        }
      }

      if (!another) {
        notify(submitted ? 'Saved and submitted for validation.' : 'Draft saved.')
        await navigate(`/inventory/${id}`)
        return
      }
      setSaved({ id, name, submitted })
      // Encoders usually work through one town's list, so the round and place stay filled in.
      reset({
        ...EMPTY,
        survey_round: v.survey_round,
        municipality: v.municipality || (farmer?.municipality.id ?? ''),
        home_barangay: v.home_barangay,
      })
      setMode('new')
      top.current?.scrollIntoView({ block: 'start' })
    })

  const noRound = rounds.isSuccess && openRounds.length === 0

  return (
    <div ref={top} className="scroll-mt-20">
      <PageHeader
        title="New entry"
        description="One farmer, one farm: the same as one row of the workbook."
      />
      <form onSubmit={(e) => void save(false)(e)} noValidate className="space-y-6">
        {saved ? (
          <Alert tone="success">
            {saved.submitted ? 'Submitted' : 'Draft saved'} for {saved.name}.{' '}
            <Link to={`/inventory/${saved.id}`} className="font-semibold underline">
              Open record
            </Link>
          </Alert>
        ) : null}
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        {noRound ? (
          <Alert tone="warning">
            There is no open survey round. Ask the program coordinator to open one.
          </Alert>
        ) : null}

        <Card>
          <SelectInput
            label="Survey round"
            required
            error={errors.survey_round?.message}
            {...register('survey_round')}
          >
            <option value="">Choose…</option>
            {openRounds.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {r.commodity_name}
                {r.is_historical ? ' (historical)' : ''}
              </option>
            ))}
          </SelectInput>
        </Card>

        <Card
          title="Farmer"
          actions={
            <div role="group" aria-label="Farmer" className="flex rounded-lg bg-sunken p-0.5">
              {(
                [
                  ['new', 'New farmer', UserPlus],
                  ['existing', 'Already registered', UserCheck],
                ] as const
              ).map(([key, label, Icon]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={mode === key}
                  onClick={() => {
                    switchMode(key)
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-semibold text-muted transition hover:text-ink aria-pressed:bg-surface aria-pressed:text-brand-800 aria-pressed:shadow-sm"
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
          }
        >
          {mode === 'existing' ? (
            values.farmer ? (
              <div className="flex items-center justify-between gap-3 rounded-xl bg-brand-50 p-3">
                <span className="flex min-w-0 items-center gap-3">
                  <Avatar name={farmer?.display_name ?? '?'} />
                  <span className="min-w-0 text-sm">
                    <span className="block font-semibold">{farmer?.display_name ?? '…'}</span>
                    <span className="block text-xs text-muted">
                      {farmer ? `${farmer.home_barangay.name}, ${farmer.municipality.name}` : ''}
                    </span>
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<X className="h-4 w-4" aria-hidden="true" />}
                  onClick={() => {
                    switchMode('existing')
                  }}
                >
                  Change
                </Button>
              </div>
            ) : (
              <FarmerSearch onPick={pickFarmer} />
            )
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <TextInput
                  label="First name"
                  autoComplete="off"
                  error={errors.first_name?.message}
                  {...register('first_name')}
                />
                <TextInput
                  label="Middle name"
                  autoComplete="off"
                  error={errors.middle_name?.message}
                  {...register('middle_name')}
                />
                <TextInput
                  label="Last name"
                  required
                  autoComplete="off"
                  error={errors.last_name?.message}
                  {...register('last_name')}
                />
                <TextInput
                  label="Suffix"
                  placeholder="Jr., Sr., III"
                  error={errors.suffix?.message}
                  {...register('suffix')}
                />
                <SelectInput
                  label="Municipality"
                  required
                  error={errors.municipality?.message}
                  {...register('municipality', {
                    onChange: () => {
                      setValue('home_barangay', '')
                      setValue('barangay', '')
                    },
                  })}
                >
                  <option value="">Choose…</option>
                  {municipalities.data?.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </SelectInput>
                <SelectInput
                  label="Home barangay"
                  required
                  disabled={!values.municipality}
                  error={errors.home_barangay?.message}
                  {...register('home_barangay')}
                >
                  <option value="">Choose…</option>
                  {homeBarangays.data?.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                      {b.is_verified ? '' : ' (unverified)'}
                    </option>
                  ))}
                </SelectInput>
                <SelectInput label="Sex" error={errors.sex?.message} {...register('sex')}>
                  <option value="">Not recorded</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                </SelectInput>
                <TextInput
                  label="Birth year"
                  inputMode="numeric"
                  error={errors.birth_year?.message}
                  {...register('birth_year')}
                />
                <TextInput
                  label="RSBSA no."
                  error={errors.rsbsa_no?.message}
                  {...register('rsbsa_no')}
                />
                <TextInput
                  label="Contact no."
                  inputMode="tel"
                  error={errors.contact_no?.message}
                  {...register('contact_no')}
                />
              </div>
              {matches.length > 0 ? (
                <Alert tone="warning" title="This farmer may already be registered">
                  <ul className="mt-1 space-y-1">
                    {matches.map((m) => (
                      <li key={m.id} className="flex flex-wrap items-center gap-x-2">
                        <span>
                          {m.display_name} ({m.home_barangay}, {m.municipality})
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            pickFarmer(m.id)
                          }}
                          className="font-semibold underline"
                        >
                          Use this farmer
                        </button>
                      </li>
                    ))}
                  </ul>
                </Alert>
              ) : null}
              <div className="rounded-xl bg-sunken p-3.5">
                <p className="mb-2.5 text-[13px] text-muted">{PRIVACY_NOTICE}</p>
                <Checkbox
                  label="I read this notice to the farmer and they agreed to the collection of their data."
                  error={errors.consent_given?.message}
                  {...register('consent_given')}
                />
              </div>
            </div>
          )}
        </Card>

        <Card title="Farm and planting">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <SelectInput
              label="Farm barangay"
              disabled={!townId}
              error={errors.barangay?.message}
              {...register('barangay')}
            >
              <option value="">Same as home barangay</option>
              {farmBarangays.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </SelectInput>
            <TextInput label="Sitio" error={errors.sitio?.message} {...register('sitio')} />
            <SelectInput label="Variety" disabled={!round} {...register('variety')}>
              <option value="">Not recorded</option>
              {varieties.data?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </SelectInput>
            <TextInput
              label="Year planted"
              inputMode="numeric"
              error={errors.year_planted?.message}
              {...register('year_planted')}
            />
            <SelectInput
              label="Source of materials"
              error={errors.source?.message}
              {...register('source')}
            >
              <option value="">Not recorded</option>
              {sources.data?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </SelectInput>
          </div>
        </Card>

        <Card
          title="Trees by growth stage"
          actions={
            <p className="text-sm text-muted">
              Total <span className="font-display font-bold text-ink">{formatNumber(total)}</span>
            </p>
          }
        >
          <div className="space-y-4">
            {round ? (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                {stages.data?.map((s) => (
                  <TextInput
                    key={s.id}
                    label={s.label}
                    inputMode="numeric"
                    className="[&_input]:text-right [&_input]:tabular-nums"
                    error={errors.counts?.[s.id]?.message}
                    {...register(`counts.${s.id}`)}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted">Choose a survey round to see its growth stages.</p>
            )}
            <TextArea label="Remarks" error={errors.remarks?.message} {...register('remarks')} />
          </div>
        </Card>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Checkbox
            label="Enter another after saving"
            checked={another}
            onChange={(e) => {
              setAnother(e.target.checked)
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant={canSubmit ? 'secondary' : 'primary'}
              loading={isSubmitting}
              disabled={noRound || isSubmitting}
            >
              Save draft
            </Button>
            {canSubmit ? (
              <Button
                loading={isSubmitting}
                disabled={noRound || isSubmitting}
                onClick={(e) => void save(true)(e)}
              >
                Save and submit
              </Button>
            ) : null}
          </div>
        </div>
      </form>
    </div>
  )
}
