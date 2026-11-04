import clsx from 'clsx'
import { CheckCircle2, Info, XCircle } from 'lucide-react'
import { useCallback, useMemo, useState, type ReactNode } from 'react'

import { ToastContext, type Tone } from './useToast'

const TOAST_ICONS: Record<Tone, { Icon: typeof Info; cls: string }> = {
  success: { Icon: CheckCircle2, cls: 'text-brand-600' },
  error: { Icon: XCircle, cls: 'text-red-700' },
  info: { Icon: Info, cls: 'text-sky-700' },
}

interface ToastItem {
  id: number
  tone: Tone
  message: string
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const notify = useCallback((message: string, tone: Tone = 'success') => {
    const id = Date.now() + Math.random()
    setItems((current) => [...current, { id, tone, message }])
    window.setTimeout(() => {
      setItems((current) => current.filter((t) => t.id !== id))
    }, 5000)
  }, [])
  const value = useMemo(() => notify, [notify])
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2"
      >
        {items.map((t) => {
          const { Icon, cls } = TOAST_ICONS[t.tone]
          return (
            <div
              key={t.id}
              role={t.tone === 'error' ? 'alert' : 'status'}
              className="surface-card pointer-events-auto flex max-w-sm animate-rise items-start gap-2.5 px-4 py-3 text-sm font-medium text-ink shadow-raised"
            >
              <Icon className={clsx('mt-0.5 h-4 w-4 shrink-0', cls)} aria-hidden="true" />
              {t.message}
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}
