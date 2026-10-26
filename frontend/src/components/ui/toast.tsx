import clsx from 'clsx'
import { useCallback, useMemo, useState, type ReactNode } from 'react'

import { ToastContext, type Tone } from './useToast'

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
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className={clsx(
              'pointer-events-auto max-w-sm rounded-md px-4 py-3 text-sm text-white shadow-lg',
              t.tone === 'error'
                ? 'bg-red-800'
                : t.tone === 'info'
                  ? 'bg-slate-800'
                  : 'bg-brand-800',
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
