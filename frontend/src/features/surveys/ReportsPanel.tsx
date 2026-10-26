import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileSpreadsheet, FileText, PenLine } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Alert, Badge, Card } from '@/components/ui/display'
import { SelectInput } from '@/components/ui/fields'
import { useToast } from '@/components/ui/useToast'
import { api, download, unwrap } from '@/lib/api/client'
import { useAuth } from '@/lib/auth/context'
import { errorMessage } from '@/lib/forms'
import { formatDate } from '@/lib/format'

type Props = {
  roundId: string
  roundName: string
  closed: boolean
  municipalities: { id: string; name: string }[]
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

const SIGNOFF_BADGE = {
  unsigned: { tone: 'gray', label: 'Not signed' },
  signed: { tone: 'green', label: 'Signed' },
  superseded: { tone: 'amber', label: 'Superseded: figures changed after signing' },
} as const

/** Official reports (ADR-0015): summary for everyone in scope, farmer lists only with
 * export_personal_data, sign-off only for sign_reports on a closed round. */
export function ReportsPanel({ roundId, roundName, closed, municipalities }: Props) {
  const { can } = useAuth()
  const notify = useToast()
  const queryClient = useQueryClient()
  const [town, setTown] = useState('')
  const [confirming, setConfirming] = useState(false)
  const townId = town || municipalities[0]?.id || ''

  const signoff = useQuery({
    queryKey: ['survey-round', roundId, 'sign-off'],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/reports/rounds/{id}/sign-off', {
          params: { path: { id: roundId } },
        }),
      ),
  })
  const sign = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST('/api/v1/reports/rounds/{id}/sign-off', {
          params: { path: { id: roundId } },
        }),
      ),
    onSuccess: async () => {
      notify('Summary report signed.')
      setConfirming(false)
      await queryClient.invalidateQueries({ queryKey: ['survey-round', roundId, 'sign-off'] })
    },
  })

  const get = (path: string, filename: string) => {
    download(path, filename).catch((err: unknown) => {
      notify(errorMessage(err), 'error')
    })
  }
  const base = `/api/v1/reports/rounds/${roundId}`
  const name = slug(roundName)
  const townName = municipalities.find((m) => m.id === townId)?.name ?? ''
  const state = signoff.data?.state

  return (
    <Card title="Official reports">
      <div className="space-y-5">
        {!closed ? (
          <Alert tone="info">
            The round is open, so reports are marked DRAFT and cannot be signed.
          </Alert>
        ) : null}
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Provincial summary</h3>
          <p className="text-sm text-muted">
            Farmers, area and plant population by stage for each municipality in your assignment.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              icon={<FileSpreadsheet className="h-4 w-4" aria-hidden="true" />}
              onClick={() => get(`${base}/summary.xlsx`, `summary-${name}.xlsx`)}
            >
              Excel
            </Button>
            <Button
              variant="secondary"
              icon={<FileText className="h-4 w-4" aria-hidden="true" />}
              onClick={() => get(`${base}/summary.pdf`, `summary-${name}.pdf`)}
            >
              PDF
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1 text-sm">
            <span className="text-muted">Sign-off:</span>
            {signoff.isPending ? (
              <span className="text-muted">Loading…</span>
            ) : signoff.isError ? (
              <span className="text-red-700">{errorMessage(signoff.error)}</span>
            ) : (
              <>
                <Badge tone={SIGNOFF_BADGE[signoff.data.state].tone}>
                  {SIGNOFF_BADGE[signoff.data.state].label}
                </Badge>
                {signoff.data.signed_by && signoff.data.signed_at ? (
                  <span className="text-muted">
                    {signoff.data.signed_by}, {formatDate(signoff.data.signed_at)}
                  </span>
                ) : null}
              </>
            )}
            {can('sign_reports') && closed && state && state !== 'signed' ? (
              <Button
                icon={<PenLine className="h-4 w-4" aria-hidden="true" />}
                onClick={() => setConfirming(true)}
              >
                Sign off summary
              </Button>
            ) : null}
          </div>
        </section>
        {can('export_personal_data') && municipalities.length > 0 ? (
          <section className="space-y-2 border-t border-line pt-4">
            <h3 className="text-sm font-semibold">Municipal farmer list</h3>
            <p className="text-sm text-muted">
              Contains personal data (RA 10173). Every download is recorded in the audit log.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <SelectInput
                label="Municipality"
                value={townId}
                onChange={(e) => setTown(e.target.value)}
                className="w-56"
              >
                {municipalities.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </SelectInput>
              <Button
                variant="secondary"
                icon={<FileSpreadsheet className="h-4 w-4" aria-hidden="true" />}
                onClick={() =>
                  get(
                    `${base}/municipal-list.xlsx?municipality=${townId}`,
                    `${slug(townName)}-${name}.xlsx`,
                  )
                }
              >
                Excel
              </Button>
              <Button
                variant="secondary"
                icon={<FileText className="h-4 w-4" aria-hidden="true" />}
                onClick={() =>
                  get(
                    `${base}/municipal-list.pdf?municipality=${townId}`,
                    `${slug(townName)}-${name}.pdf`,
                  )
                }
              >
                PDF
              </Button>
            </div>
          </section>
        ) : null}
      </div>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Sign off the provincial summary?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button loading={sign.isPending} onClick={() => sign.mutate()}>
              Sign off
            </Button>
          </>
        }
      >
        <p className="text-sm">
          Your name, the time and a fingerprint of the report&apos;s figures are recorded. If a
          record is reopened later, the sign-off is shown as superseded and must be repeated.
        </p>
        {sign.isError ? (
          <div className="mt-3">
            <Alert tone="error">{errorMessage(sign.error)}</Alert>
          </div>
        ) : null}
      </Dialog>
    </Card>
  )
}
