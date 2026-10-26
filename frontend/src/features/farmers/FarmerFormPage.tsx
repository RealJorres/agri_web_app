import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { Link, useNavigate, useParams } from 'react-router'

import { Button } from '@/components/ui/Button'
import { Alert, Card, PageHeader } from '@/components/ui/display'
import { Checkbox, SelectInput, TextInput } from '@/components/ui/fields'
import { LoadingBlock } from '@/components/ui/Spinner'
import { useToast } from '@/components/ui/useToast'
import { applyServerErrors } from '@/lib/forms'
import { useBarangays, useMunicipalities } from '@/lib/reference'

import { useDuplicates, useFarmer, useSaveFarmer, type FarmerDetail } from './api'
import { FIELDS, PRIVACY_NOTICE, defaults, farmerSchema, type FarmerFormValues } from './schema'

export default function FarmerFormPage() {
  const { id } = useParams()
  const farmer = useFarmer(id)
  if (id && farmer.isPending) return <LoadingBlock />
  if (id && farmer.isError)
    return <Alert tone="error">Farmer not found or not in your assignment.</Alert>
  return <FarmerForm key={id ?? 'new'} farmer={farmer.data} />
}

export function FarmerForm({ farmer }: { farmer?: FarmerDetail | undefined }) {
  const navigate = useNavigate()
  const notify = useToast()
  const save = useSaveFarmer(farmer?.id)
  const [formError, setFormError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setError,
    setValue,
    control,
    formState: { errors, isSubmitting },
  } = useForm<FarmerFormValues>({
    resolver: zodResolver(farmerSchema),
    defaultValues: defaults(farmer),
  })

  const municipality = useWatch({ control, name: 'municipality' })
  const barangay = useWatch({ control, name: 'home_barangay' })
  const first = useWatch({ control, name: 'first_name' })
  const last = useWatch({ control, name: 'last_name' })
  const municipalities = useMunicipalities()
  const barangays = useBarangays(municipality || undefined)

  // Live duplicate warning, debounced on name + barangay (ADR-0007 suggest threshold).
  const [probe, setProbe] = useState({ name: '', barangay: '' })
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setProbe({ name: `${first} ${last}`.trim(), barangay })
    }, 400)
    return () => {
      window.clearTimeout(handle)
    }
  }, [first, last, barangay])
  const duplicates = useDuplicates({
    name: probe.name,
    ...(probe.barangay ? { barangay: probe.barangay } : {}),
    ...(farmer ? { exclude: farmer.id } : {}),
  })

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    try {
      const saved = await save.mutateAsync({
        first_name: values.first_name,
        middle_name: values.middle_name,
        last_name: values.last_name,
        suffix: values.suffix,
        sex: values.sex,
        birth_year: values.birth_year ? Number(values.birth_year) : null,
        rsbsa_no: values.rsbsa_no || null,
        contact_no: values.contact_no,
        home_barangay: values.home_barangay,
        status: values.status,
        consent_given: values.consent_given,
      })
      notify(farmer ? 'Farmer updated.' : 'Farmer registered.')
      await navigate(`/farmers/${saved.id}`)
    } catch (err) {
      setFormError(applyServerErrors(err, setError, FIELDS))
    }
  })

  const matches = duplicates.data ?? []
  return (
    <>
      <PageHeader title={farmer ? `Edit ${farmer.display_name}` : 'New farmer'} />
      <form onSubmit={(e) => void onSubmit(e)} noValidate className="space-y-6">
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <Card title="Identity">
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
            <div className="mt-4">
              <Alert tone="warning" title="This farmer may already be registered">
                <ul className="list-disc pl-5">
                  {matches.map((m) => (
                    <li key={m.id}>
                      <Link
                        to={`/farmers/${m.id}`}
                        className="font-medium underline"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {m.display_name}
                      </Link>{' '}
                      ({m.home_barangay}, {m.municipality}) —{' '}
                      {m.reason === 'rsbsa'
                        ? 'same RSBSA no.'
                        : `${String(Math.round(m.similarity * 100))}% name match`}
                    </li>
                  ))}
                </ul>
                <p>Check before saving. You can still save if this is a different person.</p>
              </Alert>
            </div>
          ) : null}
        </Card>

        <Card title="Location and status">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <SelectInput
              label="Municipality"
              required
              error={errors.municipality?.message}
              {...register('municipality', {
                onChange: () => {
                  setValue('home_barangay', '')
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
              disabled={!municipality}
              error={errors.home_barangay?.message}
              {...register('home_barangay')}
            >
              <option value="">Choose…</option>
              {barangays.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                  {b.is_verified ? '' : ' (unverified)'}
                </option>
              ))}
            </SelectInput>
            <SelectInput label="Status" error={errors.status?.message} {...register('status')}>
              <option value="active">Active</option>
              <option value="needs_review">Needs review</option>
              <option value="inactive">Inactive</option>
            </SelectInput>
          </div>
        </Card>

        <Card title="Privacy notice and consent">
          <p className="mb-3 text-sm text-ink">{PRIVACY_NOTICE}</p>
          {farmer?.has_consent ? (
            <p className="text-sm text-muted">
              Consent recorded on {new Date(farmer.consent_at ?? '').toLocaleDateString('en-PH')}.
            </p>
          ) : (
            <Checkbox
              label="I read this notice to the farmer and they agreed to the collection of their data."
              error={errors.consent_given?.message}
              {...register('consent_given')}
            />
          )}
        </Card>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={() => void navigate(-1)}>
            Cancel
          </Button>
          <Button type="submit" loading={isSubmitting}>
            {farmer ? 'Save changes' : 'Register farmer'}
          </Button>
        </div>
      </form>
    </>
  )
}
