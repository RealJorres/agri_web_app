import { useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Alert } from '@/components/ui/display'
import { errorMessage } from '@/lib/forms'

/** Asks before removing something, and shows the reason if the server refuses. */
export function ConfirmDialog({
  open,
  title,
  children,
  action,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  children: ReactNode
  action: string
  onConfirm: () => Promise<unknown>
  onClose: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const close = () => {
    setError(null)
    onClose()
  }
  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
      close()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void confirm()}>
            {action}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="text-sm">{children}</div>
      </div>
    </Dialog>
  )
}
