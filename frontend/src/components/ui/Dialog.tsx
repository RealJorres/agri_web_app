import clsx from 'clsx'
import { X } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'

interface DialogProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  variant?: 'modal' | 'drawer'
}

/** Native <dialog>: focus trapping, Esc to close and inert background come from the browser. */
export function Dialog({ open, onClose, title, children, footer, variant = 'modal' }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal()
      else dialog.setAttribute('open', '')
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close()
      else dialog.removeAttribute('open')
    }
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      className={clsx(
        'bg-surface p-0 text-ink shadow-overlay',
        variant === 'drawer'
          ? 'ml-auto mr-0 h-full max-h-full w-full max-w-xl'
          : 'm-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl',
      )}
    >
      {open ? (
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-4">
            <h2 id={titleId} className="text-lg font-bold">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-muted transition hover:bg-sunken hover:text-ink"
              aria-label="Close"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-5">{children}</div>
          {footer ? (
            <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-sunken px-5 py-3.5">
              {footer}
            </div>
          ) : null}
        </div>
      ) : null}
    </dialog>
  )
}
