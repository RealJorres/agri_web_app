import { createContext, useContext } from 'react'

export type Tone = 'success' | 'error' | 'info'
export type Notify = (message: string, tone?: Tone) => void

export const ToastContext = createContext<Notify | null>(null)

export function useToast(): Notify {
  const value = useContext(ToastContext)
  if (!value) throw new Error('useToast must be used inside <ToastProvider>')
  return value
}
