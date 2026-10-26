import { ClipboardPlus, Pencil, Plus } from 'lucide-react'
import { useState, type SyntheticEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import {
  Alert,
  Badge,
  Card,
  DefinitionList,
  EmptyState,
  PageHeader,
  StatusBadge,
} from '@/components/ui/display'
import { SelectInput, TextInput } from '@/components/ui/fields'
import { LoadingBlock } from '@/components/ui/Spinner'
import { useToast } from '@/components/ui/useToast'
import { useAuth } from '@/lib/auth/context'
import { errorMessage } from '@/lib/forms'
import { formatDate, formatDateTime, formatNumber } from '@/lib/format'
import { useBarangays, useCommodities } from '@/lib/reference'

import {
  useCreateFarm,
  useFarmer,
  useFarmerAudit,
  useFarmsOf,
  useRecordsOf,
  type FarmerDetail,
} from './api'

export default function FarmerDetailPage() {
  const { id = '' } = useParams()
  const farmer = useFarmer(id)
  if (farmer.isPending) return <LoadingBlock />
  if (farmer.isError) return <Alert tone="error">Farmer not found or not in your assignment.</Alert>
  return <FarmerDetail farmer={farmer.data} />
}

function FarmerDetail({ farmer }: { farmer: FarmerDetail }) {
  const navigate = useNavigate()
  const { can } = useAuth()
  const [addingFarm, setAddingFarm] = useState(false)
  return (
    <>
      <PageHeader
        title={farmer.display_name}
        description={`${farmer.home_barangay.name}, ${farmer.municipality.name}`}
        actions={
          can('edit_records') ? (
            <Button
              variant="secondary"
              icon={<Pencil className="h-4 w-4" aria-hidden="true" />}
              onClick={() => void navigate('edit')}
            >
              Edit
            </Button>
          ) : null
        }
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Profile" actions={<StatusBadge status={farmer.status} />}>
            <DefinitionList
              items={[
                ['Sex', farmer.sex || '—'],
                ['Birth year', farmer.birth_year ?? '—'],
                ['RSBSA no.', farmer.rsbsa_no ?? '—'],
                ['Contact no.', farmer.contact_no || '—'],
                ['Name as recorded', farmer.full_name_raw || '—'],
                [
                  'Consent',
                  farmer.has_consent ? (
                    `Recorded ${formatDate(farmer.consent_at)}`
                  ) : (
                    <Badge tone="amber">Not recorded</Badge>
                  ),
                ],
              ]}
            />
          </Card>
          <Card
            title="Farms and crops"
            actions={
              can('edit_records') ? (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Plus className="h-4 w-4" aria-hidden="true" />}
                  onClick={() => setAddingFarm(true)}
                >
                  Add farm
                </Button>
              ) : null
            }
          >
            <Farms farmerId={farmer.id} />
          </Card>
          <Card title="Inventory history">
            <Records farmerId={farmer.id} />
          </Card>
        </div>
        <div className="space-y-6">
          <Card title="Associations">
            {farmer.memberships.length === 0 ? (
              <p className="text-sm text-muted">Not a member of any association.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {farmer.memberships.map((m) => (
                  <li key={m.id}>
                    <Link
                      to={`/associations/${m.association.id}`}
                      className="font-medium text-brand-800 hover:underline"
                    >
                      {m.association.name}
                    </Link>
                    {m.role ? <span className="text-muted"> · {m.role}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Audit trail">
            <AuditTrail farmerId={farmer.id} />
          </Card>
        </div>
      </div>
      <AddFarmDialog
        farmer={farmer}
        open={addingFarm}
        onClose={() => {
          setAddingFarm(false)
        }}
      />
    </>
  )
}

function Farms({ farmerId }: { farmerId: string }) {
  const farms = useFarmsOf(farmerId)
  const { can } = useAuth()
  if (farms.isPending) return <LoadingBlock />
  if (farms.isError) return <Alert tone="error">{errorMessage(farms.error)}</Alert>
  if (farms.data.results.length === 0) return <EmptyState title="No farms recorded yet" />
  return (
    <ul className="space-y-4">
      {farms.data.results.map((farm) => (
        <li key={farm.id} className="rounded-md border border-line p-3">
          <p className="font-medium">
            {farm.barangay.name}, {farm.municipality.name}
            {farm.sitio ? (
              <span className="font-normal text-muted"> · Sitio {farm.sitio}</span>
            ) : null}
          </p>
          {farm.location_raw ? (
            <p className="text-xs text-muted">Recorded as: {farm.location_raw}</p>
          ) : null}
          {farm.crop_stands.map((stand) => (
            <div key={stand.id} className="mt-3 border-t border-line pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">{stand.commodity.name}</p>
                {can('edit_records') ? (
                  <Link
                    to={`/inventory/new?crop_stand=${stand.id}`}
                    className="inline-flex items-center gap-1 text-sm font-medium text-brand-800 hover:underline"
                  >
                    <ClipboardPlus className="h-4 w-4" aria-hidden="true" />
                    Record inventory
                  </Link>
                ) : null}
              </div>
              {stand.plantings.length ? (
                <ul className="mt-1 text-sm text-muted">
                  {stand.plantings.map((p) => (
                    <li key={p.id}>
                      Planted {p.year_planted ?? 'year unknown'}
                      {p.varieties.length ? ` · ${p.varieties.join(', ')}` : ''}
                      {p.source ? ` · source ${p.source}` : ''}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-sm text-muted">No planting details.</p>
              )}
            </div>
          ))}
        </li>
      ))}
    </ul>
  )
}

function Records({ farmerId }: { farmerId: string }) {
  const records = useRecordsOf(farmerId)
  if (records.isPending) return <LoadingBlock />
  if (records.isError) return <Alert tone="error">{errorMessage(records.error)}</Alert>
  if (records.data.results.length === 0) return <EmptyState title="No inventory records yet" />
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <caption className="sr-only">Inventory records</caption>
        <thead>
          <tr className="text-left text-muted">
            <th scope="col" className="py-1.5 font-medium">
              Round
            </th>
            <th scope="col" className="py-1.5 font-medium">
              Farm
            </th>
            <th scope="col" className="py-1.5 text-right font-medium">
              Trees
            </th>
            <th scope="col" className="py-1.5 pl-4 font-medium">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {records.data.results.map((r) => (
            <tr key={r.id} className="border-t border-line">
              <td className="py-2">
                <Link
                  to={`/inventory/${r.id}`}
                  className="font-medium text-brand-800 hover:underline"
                >
                  {r.survey_round.name}
                </Link>
              </td>
              <td className="py-2">{r.farm.barangay}</td>
              <td className="py-2 text-right tabular-nums">{formatNumber(r.total)}</td>
              <td className="py-2 pl-4">
                <StatusBadge status={r.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function AuditTrail({ farmerId }: { farmerId: string }) {
  const audit = useFarmerAudit(farmerId)
  if (audit.isPending) return <LoadingBlock />
  if (audit.isError) return <Alert tone="error">{errorMessage(audit.error)}</Alert>
  if (audit.data.results.length === 0)
    return <p className="text-sm text-muted">No changes recorded.</p>
  return (
    <ol className="space-y-3 text-sm">
      {audit.data.results.map((entry) => (
        <li key={entry.id}>
          <p className="font-medium">{entry.action.replace('.', ' · ')}</p>
          <p className="text-xs text-muted">
            {formatDateTime(entry.created_at)} · {entry.actor ?? 'system'}
          </p>
          {entry.after && Object.keys(entry.after).length ? (
            <p className="text-xs text-muted">Changed: {Object.keys(entry.after).join(', ')}</p>
          ) : null}
        </li>
      ))}
    </ol>
  )
}

function AddFarmDialog({
  farmer,
  open,
  onClose,
}: {
  farmer: FarmerDetail
  open: boolean
  onClose: () => void
}) {
  const notify = useToast()
  const barangays = useBarangays(farmer.municipality.id)
  const commodities = useCommodities()
  const create = useCreateFarm(farmer.id)
  const [barangay, setBarangay] = useState(farmer.home_barangay.id)
  const [sitio, setSitio] = useState('')
  const [commodity, setCommodity] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault()
    setError(null)
    const chosen = commodity || commodities.data?.[0]?.id
    if (!chosen) return
    try {
      await create.mutateAsync({ barangay, sitio, commodity: chosen })
      notify('Farm added.')
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add farm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="add-farm" loading={create.isPending}>
            Add farm
          </Button>
        </>
      }
    >
      <form id="add-farm" className="space-y-4" onSubmit={(e) => void submit(e)}>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <SelectInput
          label="Barangay"
          required
          value={barangay}
          onChange={(e) => setBarangay(e.target.value)}
        >
          {barangays.data?.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </SelectInput>
        <TextInput label="Sitio" value={sitio} onChange={(e) => setSitio(e.target.value)} />
        <SelectInput
          label="Crop"
          required
          value={commodity}
          onChange={(e) => setCommodity(e.target.value)}
        >
          {commodities.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectInput>
      </form>
    </Dialog>
  )
}
