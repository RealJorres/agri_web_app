import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Lock } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'react-router'

import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Alert, Badge, Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui/display'
import { LoadingBlock } from '@/components/ui/Spinner'
import { useToast } from '@/components/ui/useToast'
import { api, download, unwrap } from '@/lib/api/client'
import { useAuth } from '@/lib/auth/context'
import { errorMessage } from '@/lib/forms'
import { formatDate, formatHectares, formatNumber } from '@/lib/format'

export default function RoundDetailPage() {
  const { id = '' } = useParams()
  const { can } = useAuth()
  const notify = useToast()
  const [confirming, setConfirming] = useState(false)
  const queryClient = useQueryClient()
  const round = useQuery({
    queryKey: ['survey-round', id],
    queryFn: async () =>
      unwrap(await api.GET('/api/v1/survey-rounds/{id}', { params: { path: { id } } })),
  })
  const progress = useQuery({
    queryKey: ['survey-round', id, 'progress'],
    queryFn: async () =>
      unwrap(await api.GET('/api/v1/survey-rounds/{id}/progress', { params: { path: { id } } })),
  })
  const totals = useQuery({
    queryKey: ['survey-round', id, 'totals'],
    queryFn: async () =>
      unwrap(await api.GET('/api/v1/survey-rounds/{id}/totals', { params: { path: { id } } })),
  })
  const close = useMutation({
    mutationFn: async () =>
      unwrap(await api.POST('/api/v1/survey-rounds/{id}/close', { params: { path: { id } } })),
    onSuccess: async (result) => {
      notify(`Round closed. ${String(result.locked)} records locked.`)
      setConfirming(false)
      await queryClient.invalidateQueries({ queryKey: ['survey-round', id] })
      await queryClient.invalidateQueries({ queryKey: ['survey-rounds'] })
    },
  })

  if (round.isPending) return <LoadingBlock />
  if (round.isError) return <Alert tone="error">{errorMessage(round.error)}</Alert>
  const r = round.data

  const municipalities = [...new Set((totals.data ?? []).map((t) => t.municipality))]
  const stages = [...new Map((totals.data ?? []).map((t) => [t.stage_code, t])).values()].sort(
    (a, b) => a.sort_order - b.sort_order,
  )
  const cell = (m: string, s: string) =>
    totals.data?.find((t) => t.municipality === m && t.stage_code === s)

  return (
    <>
      <PageHeader
        title={r.name}
        description={`${r.commodity_name} · as of ${formatDate(r.as_of_date)}`}
        actions={
          <>
            {r.is_historical ? <Badge tone="amber">Historical</Badge> : null}
            <StatusBadge status={r.status} />
            {can('export_personal_data') ? (
              <Button
                variant="secondary"
                icon={<Download className="h-4 w-4" aria-hidden="true" />}
                onClick={() => {
                  download(
                    `/api/v1/exports/inventory.xlsx?survey_round=${id}`,
                    'inventory.xlsx',
                  ).catch((err: unknown) => {
                    notify(errorMessage(err), 'error')
                  })
                }}
              >
                Export records
              </Button>
            ) : null}
            {can('manage_rounds') && r.status === 'open' ? (
              <Button
                variant="danger"
                icon={<Lock className="h-4 w-4" aria-hidden="true" />}
                onClick={() => setConfirming(true)}
              >
                Close round
              </Button>
            ) : null}
          </>
        }
      />
      <div className="space-y-6">
        <Card title="Progress by municipality">
          {progress.isPending ? (
            <LoadingBlock />
          ) : progress.isError ? (
            <Alert tone="error">{errorMessage(progress.error)}</Alert>
          ) : progress.data.length === 0 ? (
            <EmptyState title="No crop stands in your assignment yet" />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <caption className="sr-only">Records by status for each municipality</caption>
                <thead>
                  <tr className="text-left text-muted">
                    <th scope="col" className="py-1.5 font-medium">
                      Municipality
                    </th>
                    {['Expected', 'Draft', 'Submitted', 'Validated', 'Approved', 'Locked'].map(
                      (h) => (
                        <th key={h} scope="col" className="py-1.5 text-right font-medium">
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {progress.data.map((p) => (
                    <tr key={p.municipality_id} className="border-t border-line">
                      <th scope="row" className="py-2 text-left font-medium">
                        {p.municipality}
                      </th>
                      {[p.expected, p.draft, p.submitted, p.validated, p.approved, p.locked].map(
                        (n, i) => (
                          <td key={i} className="py-2 text-right tabular-nums">
                            {formatNumber(n)}
                          </td>
                        ),
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Official totals (approved records)">
          {totals.isPending ? (
            <LoadingBlock />
          ) : totals.isError ? (
            <Alert tone="error">{errorMessage(totals.error)}</Alert>
          ) : totals.data.length === 0 ? (
            <EmptyState title="No approved records yet" />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <caption className="sr-only">
                  Trees and derived area by municipality and stage
                </caption>
                <thead>
                  <tr className="text-left text-muted">
                    <th scope="col" className="py-1.5 font-medium">
                      Municipality
                    </th>
                    {stages.map((s) => (
                      <th key={s.stage_code} scope="col" className="py-1.5 text-right font-medium">
                        {s.stage_label}
                      </th>
                    ))}
                    <th scope="col" className="py-1.5 text-right font-medium">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {municipalities.map((m) => {
                    const row = stages.map((s) => cell(m, s.stage_code))
                    const total = row.reduce((sum, c) => sum + (c?.count ?? 0), 0)
                    return (
                      <tr key={m} className="border-t border-line">
                        <th scope="row" className="py-2 text-left font-medium">
                          {m}
                        </th>
                        {row.map((c, i) => (
                          <td key={i} className="py-2 text-right tabular-nums">
                            {formatNumber(c?.count ?? 0)}
                            <span className="block text-xs text-muted">
                              {formatHectares(c?.area_ha)}
                            </span>
                          </td>
                        ))}
                        <td className="py-2 text-right font-semibold tabular-nums">
                          {formatNumber(total)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Close this round?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={close.isPending} onClick={() => close.mutate()}>
              Close and lock
            </Button>
          </>
        }
      >
        <p className="text-sm">
          Approved records will be locked. Records still awaiting validation or approval must be
          resolved first. Locked records can only be changed by reopening them, which is recorded in
          the audit log.
        </p>
        {close.isError ? (
          <div className="mt-3">
            <Alert tone="error">{errorMessage(close.error)}</Alert>
          </div>
        ) : null}
      </Dialog>
    </>
  )
}
