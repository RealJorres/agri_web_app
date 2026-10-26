import { useState } from 'react'

import { Button } from '@/components/ui/Button'
import { Alert } from '@/components/ui/display'
import { TextArea } from '@/components/ui/fields'
import { useToast } from '@/components/ui/useToast'
import { errorMessage } from '@/lib/forms'
import { formatDateTime } from '@/lib/format'

import { useComments, useTransition, type InventoryRecord, type WorkflowAction } from './api'

const LABELS: Record<WorkflowAction, string> = {
  submit: 'Submit for validation',
  validate: 'Validate',
  approve: 'Approve',
  return: 'Return for correction',
  reopen: 'Reopen',
}
const NEEDS_COMMENT: WorkflowAction[] = ['return', 'reopen']
const DONE: Record<WorkflowAction, string> = {
  submit: 'Submitted for validation.',
  validate: 'Record validated.',
  approve: 'Record approved.',
  return: 'Record returned to the encoder.',
  reopen: 'Record reopened as a new version.',
}

/** Buttons come from the API's allowed_actions; the server re-checks every action. */
export function WorkflowActions({
  record,
  exclude = [],
  onDone,
}: {
  record: InventoryRecord
  exclude?: WorkflowAction[]
  onDone?: (record: InventoryRecord) => void
}) {
  const notify = useToast()
  const transition = useTransition()
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)
  const actions = record.allowed_actions.filter(
    (a): a is WorkflowAction => a in LABELS && !exclude.includes(a as WorkflowAction),
  )
  if (actions.length === 0) return null

  const run = async (action: WorkflowAction) => {
    setError(null)
    if (NEEDS_COMMENT.includes(action) && !comment.trim()) {
      setError('Please explain why in the comment box.')
      return
    }
    try {
      const updated = await transition.mutateAsync({
        id: record.id,
        action,
        comment: comment.trim(),
      })
      notify(DONE[action])
      setComment('')
      onDone?.(updated)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <div className="space-y-3">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <TextArea
        label="Comment"
        hint="Required when returning or reopening. Visible in the record history."
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <Button
            key={action}
            variant={action === 'return' || action === 'reopen' ? 'secondary' : 'primary'}
            loading={transition.isPending && transition.variables.action === action}
            disabled={transition.isPending}
            onClick={() => void run(action)}
          >
            {LABELS[action]}
          </Button>
        ))}
      </div>
    </div>
  )
}

interface Warning {
  code: string
  message: string
}

export function RecordFlags({ record }: { record: InventoryRecord }) {
  const flags = record.flags as
    { warnings?: Warning[]; missing?: string[]; source?: string } | undefined
  const warnings = flags?.warnings ?? []
  const missing = flags?.missing ?? []
  if (!warnings.length && !missing.length && !flags?.source) return null
  return (
    <div className="space-y-2">
      {warnings.map((w, i) => (
        <Alert
          key={`${w.code}-${String(i)}`}
          tone="warning"
          title={w.code === 'outlier' ? 'Unusual count' : 'Please check'}
        >
          {w.message}
        </Alert>
      ))}
      {flags?.source === 'legacy_import' ? (
        <Alert tone="info" title="Imported from the 2023 workbook">
          {missing.length
            ? `Missing in the source: ${missing.join(', ')}.`
            : 'All main fields were present.'}
        </Alert>
      ) : null}
    </div>
  )
}

export function CommentHistory({ recordId }: { recordId: string }) {
  const comments = useComments(recordId)
  if (!comments.data?.length) return null
  return (
    <ol className="space-y-2 text-sm">
      {comments.data.map((c) => (
        <li key={c.id} className="rounded-md bg-slate-50 p-2">
          <p>{c.body}</p>
          <p className="mt-1 text-xs text-muted">
            {c.action} · {c.author} · {formatDateTime(c.created_at)}
          </p>
        </li>
      ))}
    </ol>
  )
}
