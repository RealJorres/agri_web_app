import clsx from 'clsx'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { Spinner } from './Spinner'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-brand-700 text-white shadow-sm shadow-brand-900/25 hover:bg-brand-800 disabled:bg-line-strong disabled:text-muted disabled:shadow-none',
  secondary:
    'bg-surface text-ink shadow-sm ring-1 ring-inset ring-line-strong hover:bg-sunken disabled:text-muted disabled:bg-sunken disabled:shadow-none',
  danger:
    'bg-red-700 text-white shadow-sm hover:bg-red-800 disabled:bg-line-strong disabled:text-muted',
  ghost: 'text-brand-800 hover:bg-brand-50 disabled:text-muted',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: 'sm' | 'md'
  loading?: boolean
  icon?: ReactNode
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  className,
  children,
  disabled,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled ?? loading}
      aria-busy={loading || undefined}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition',
        'active:not-disabled:translate-y-px disabled:cursor-not-allowed',
        size === 'sm' ? 'min-h-8 px-3 py-1 text-[13px]' : 'min-h-10 px-4 py-2 text-sm',
        VARIANTS[variant],
        className,
      )}
      {...props}
    >
      {loading ? <Spinner size="sm" /> : icon}
      {children}
    </button>
  )
}
