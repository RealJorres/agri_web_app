import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Download } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'react-router'

import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Alert, Card, EmptyState, PageHeader, Stat, StatusBadge } from '@/components/ui/display'
import { LoadingBlock, Spinner } from '@/components/ui/Spinner'
import { useToast } from '@/components/ui/useToast'
import { api, download, unwrap } from '@/lib/api/client'
import { errorMessage } from '@/lib/forms'
import { formatNumber, formatSigned } from '@/lib/format'

interface ReviewItem {
  sheet: string
  row: number
  kind: string
  message: string
  value: string
}
interface StageCell {
  computed: number
  workbook: number | null
  summary: number | null
  diff_workbook: number | null
  formula: string
  skipped_rows: number[]
}
interface Reconciliation {
  stages: string[]
  municipalities: {
    municipality: string
    stages: Record<string, StageCell>
    computed_total: number
    workbook_total: number
    diff_total: number
  }[]
  province: {
    computed: Record<string, number>
    workbook: Record<string, number>
    computed_total: number
    workbook_total: number
    area_ha: string | null
  }
  differences: string[]
}
interface Summary {
  counts?: Record<string, number>
  errors?: { sheet: string; row: number; messages: string[] }[]
  review?: ReviewItem[]
  decisions?: Record<
    string,
    {
      raw?: string
      result?: string
      rows?: number
      barangay?: string
      municipality?: string
      use?: string
      decision?: string
      score?: number
    }[]
  >
  reconciliation?: Reconciliation | null
  sheet_issues?: string[]
  already_imported?: boolean
  commit?: Record<string, unknown>
}

const BUSY = ['uploaded', 'validating', 'committing']
const TABS = ['Summary', 'Reconciliation', 'Review list', 'Decisions', 'Errors'] as const

const COUNT_LABELS: Record<string, string> = {
  named_rows: 'Named farmer rows',
  rows_with_trees: 'Rows with trees',
  below_total_rows: 'Rows below the TOTAL',
  name_only_rows: 'Name-only rows (not imported)',
  farmers: 'Farmers',
  records: 'Records',
  harvests: 'Harvests from remarks',
  review_items: 'Items to review',
  new_barangays: 'New (unverified) barangays',
  rows: 'Rows',
  valid_rows: 'Valid rows',
  rows_with_errors: 'Rows with errors',
  existing_farmers: 'Existing farmers matched',
}

export default function ImportDetailPage() {
  const { id = '' } = useParams()
  const notify = useToast()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<(typeof TABS)[number]>('Summary')
  const [confirming, setConfirming] = useState(false)
  const job = useQuery({
    queryKey: ['import', id],
    queryFn: async () =>
      unwrap(await api.GET('/api/v1/imports/{id}', { params: { path: { id } } })),
    refetchInterval: (query) => (BUSY.includes(query.state.data?.status ?? '') ? 1500 : false),
  })
  const commit = useMutation({
    mutationFn: async () =>
      unwrap(await api.POST('/api/v1/imports/{id}/commit', { params: { path: { id } }, body: {} })),
    onSuccess: async () => {
      setConfirming(false)
      notify('Commit started.', 'info')
      await queryClient.invalidateQueries({ queryKey: ['import', id] })
    },
  })

  if (job.isPending) return <LoadingBlock />
  if (job.isError) return <Alert tone="error">{errorMessage(job.error)}</Alert>
  const j = job.data
  const summary = (j.summary ?? {}) as Summary
  const status = j.status

  return (
    <>
      <PageHeader
        title={j.original_name}
        description={`Uploaded by ${j.uploaded_by}`}
        actions={
          <>
            <StatusBadge status={status} />
            {j.has_error_report ? (
              <Button
                variant="secondary"
                icon={<Download className="h-4 w-4" aria-hidden="true" />}
                onClick={() => {
                  download(`/api/v1/imports/${id}/error-report`, 'import-errors.xlsx').catch(
                    (err: unknown) => {
                      notify(errorMessage(err), 'error')
                    },
                  )
                }}
              >
                Error report
              </Button>
            ) : null}
            {status === 'ready' ? (
              <Button onClick={() => setConfirming(true)}>Commit import</Button>
            ) : null}
          </>
        }
      />
      {BUSY.includes(status) ? (
        <Card>
          <Spinner
            label={
              status === 'committing' ? 'Importing… this can take a minute.' : 'Checking the file…'
            }
          />
        </Card>
      ) : status === 'failed' ? (
        <Alert tone="error" title="Import failed">
          {j.error_message || 'The file could not be processed.'} Nothing was saved.
        </Alert>
      ) : (
        <div className="space-y-4">
          {summary.already_imported ? (
            <Alert tone="info">
              This file was imported before. Committing again only adds rows that are new.
            </Alert>
          ) : null}
          {status === 'committed' ? <CommitResult result={summary.commit ?? {}} /> : null}
          <div
            role="tablist"
            aria-label="Preview sections"
            className="flex flex-wrap gap-1 border-b border-line"
          >
            {TABS.map((t) => (
              <button
                key={t}
                role="tab"
                type="button"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={clsx(
                  '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
                  tab === t
                    ? 'border-brand-700 text-brand-800'
                    : 'border-transparent text-muted hover:text-ink',
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <div role="tabpanel" aria-label={tab}>
            {tab === 'Summary' ? <SummaryTab summary={summary} /> : null}
            {tab === 'Reconciliation' ? (
              <ReconciliationTab rec={summary.reconciliation ?? null} />
            ) : null}
            {tab === 'Review list' ? <ReviewTab items={summary.review ?? []} /> : null}
            {tab === 'Decisions' ? <DecisionsTab decisions={summary.decisions ?? {}} /> : null}
            {tab === 'Errors' ? <ErrorsTab summary={summary} /> : null}
          </div>
        </div>
      )}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Commit this import?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button loading={commit.isPending} onClick={() => commit.mutate()}>
              Commit
            </Button>
          </>
        }
      >
        <p className="text-sm">
          Everything in the preview is saved in one step: farmers, farms, plantings and inventory
          records. Rows with errors are skipped. You cannot undo a commit, but every change is in
          the audit log.
        </p>
        {commit.isError ? (
          <div className="mt-3">
            <Alert tone="error">{errorMessage(commit.error)}</Alert>
          </div>
        ) : null}
      </Dialog>
    </>
  )
}

function SummaryTab({ summary }: { summary: Summary }) {
  const counts = Object.entries(summary.counts ?? {})
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {counts.map(([key, value]) => (
          <Stat
            key={key}
            label={COUNT_LABELS[key] ?? key.replaceAll('_', ' ')}
            value={formatNumber(value)}
          />
        ))}
      </div>
      {summary.sheet_issues?.length ? (
        <Alert tone="warning" title="File notes">
          <ul className="list-disc pl-5">
            {summary.sheet_issues.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
    </div>
  )
}

function ReconciliationTab({ rec }: { rec: Reconciliation | null }) {
  if (!rec) return <EmptyState title="No reconciliation for this kind of file" />
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Farmer rows (what will be imported) compared with the workbook’s own TOTAL rows. Differences
        are highlighted.
      </p>
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="min-w-full text-sm">
          <caption className="sr-only">Reconciliation by municipality and stage</caption>
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-semibold">
                Municipality
              </th>
              {rec.stages.map((s) => (
                <th key={s} scope="col" className="px-3 py-2 text-right font-semibold">
                  {s.toLowerCase()}
                </th>
              ))}
              <th scope="col" className="px-3 py-2 text-right font-semibold">
                Total
              </th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">
                vs workbook
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rec.municipalities.map((m) => (
              <tr key={m.municipality} className={clsx(m.diff_total !== 0 && 'bg-amber-50')}>
                <th scope="row" className="px-3 py-2 text-left font-medium">
                  {m.municipality}
                </th>
                {rec.stages.map((s) => {
                  const c = m.stages[s]
                  return (
                    <td key={s} className="px-3 py-2 text-right tabular-nums">
                      {formatNumber(c?.computed)}
                      {c?.diff_workbook ? (
                        <span className="block text-xs font-semibold text-amber-900">
                          {formatSigned(c.diff_workbook)}{' '}
                          {c.skipped_rows.length ? `(${c.formula})` : ''}
                        </span>
                      ) : null}
                    </td>
                  )
                })}
                <td className="px-3 py-2 text-right font-semibold tabular-nums">
                  {formatNumber(m.computed_total)}
                </td>
                <td
                  className={clsx(
                    'px-3 py-2 text-right tabular-nums',
                    m.diff_total !== 0 && 'font-semibold text-amber-900',
                  )}
                >
                  {formatSigned(m.diff_total)}
                </td>
              </tr>
            ))}
            <tr className="bg-slate-50 font-semibold">
              <th scope="row" className="px-3 py-2 text-left">
                Province
              </th>
              {rec.stages.map((s) => (
                <td key={s} className="px-3 py-2 text-right tabular-nums">
                  {formatNumber(rec.province.computed[s])}
                </td>
              ))}
              <td className="px-3 py-2 text-right tabular-nums">
                {formatNumber(rec.province.computed_total)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatSigned(rec.province.computed_total - rec.province.workbook_total)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-sm text-muted">
        Workbook total {formatNumber(rec.province.workbook_total)} · area at configured density{' '}
        {rec.province.area_ha ?? '—'} ha
      </p>
      {rec.differences.length ? (
        <Alert tone="warning" title="Differences found">
          <ul className="list-disc pl-5">
            {rec.differences.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </Alert>
      ) : (
        <Alert tone="success">The farmer rows match the workbook totals.</Alert>
      )}
    </div>
  )
}

function ReviewTab({ items }: { items: ReviewItem[] }) {
  if (items.length === 0) return <EmptyState title="Nothing needs review" />
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="min-w-full text-sm">
        <caption className="sr-only">Items to review</caption>
        <thead className="bg-slate-50">
          <tr className="text-left">
            <th scope="col" className="px-3 py-2 font-semibold">
              Where
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Issue
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Value
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {items.map((i, n) => (
            <tr key={`${i.sheet}-${String(i.row)}-${String(n)}`}>
              <td className="whitespace-nowrap px-3 py-2">
                {i.sheet} row {i.row}
              </td>
              <td className="px-3 py-2">{i.message}</td>
              <td className="px-3 py-2 font-mono text-xs">{i.value || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DecisionsTab({ decisions }: { decisions: NonNullable<Summary['decisions']> }) {
  const groups = Object.entries(decisions).filter(([, rows]) => rows.length)
  if (groups.length === 0) return <EmptyState title="No values needed normalising" />
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {groups.map(([kind, rows]) => (
        <Card key={kind} title={kind.replaceAll('_', ' ')}>
          <ul className="space-y-1 text-sm">
            {rows.map((r, n) => (
              <li key={n}>
                {kind === 'new_barangays' ? (
                  <>
                    {r.barangay} ({r.municipality}) · {r.rows} row(s)
                  </>
                ) : kind === 'associations' ? (
                  <>
                    “{r.raw}” → {r.use}{' '}
                    <span className="text-muted">
                      ({r.decision}, {r.score}%)
                    </span>
                  </>
                ) : (
                  <>
                    <span className="font-mono text-xs">“{r.raw}”</span> → {r.result}{' '}
                    <span className="text-muted">· {r.rows} row(s)</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  )
}

function ErrorsTab({ summary }: { summary: Summary }) {
  const errors = summary.errors ?? []
  if (errors.length === 0) return <EmptyState title="No blocking errors" />
  return (
    <ul className="space-y-2 text-sm">
      {errors.map((e) => (
        <li
          key={`${e.sheet}-${String(e.row)}`}
          className="rounded-md border border-red-200 bg-red-50 p-2 text-red-900"
        >
          <span className="font-medium">Row {e.row}:</span> {e.messages.join(' ')}
        </li>
      ))}
    </ul>
  )
}

function CommitResult({ result }: { result: Record<string, unknown> }) {
  const total = result.official_total as number | undefined
  return (
    <Alert tone="success" title="Import committed">
      {Object.entries(result)
        .filter(([, v]) => typeof v === 'number')
        .map(([k, v]) => `${k.replaceAll('_', ' ')}: ${formatNumber(v as number)}`)
        .join(' · ')}
      {total !== undefined ? (
        <p className="font-semibold">Official round total: {formatNumber(total)} trees</p>
      ) : null}
    </Alert>
  )
}
