import clsx from 'clsx'
import { AlertTriangle, CheckCircle2, Info, Inbox, XCircle, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { STATUS_LABELS } from '@/lib/format'

export function Card({
  title,
  description,
  icon: Icon,
  actions,
  children,
  className,
}: {
  title?: ReactNode
  description?: ReactNode
  icon?: LucideIcon
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={clsx('surface-card', className)}>
      {title || actions ? (
        <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-5 pt-5">
          <div className="flex min-w-0 items-start gap-3">
            {Icon ? <IconTile icon={Icon} /> : null}
            <div className="min-w-0">
              {title ? <h2 className="text-base font-bold text-ink">{title}</h2> : null}
              {description ? <p className="mt-0.5 text-[13px] text-muted">{description}</p> : null}
            </div>
          </div>
          {actions}
        </header>
      ) : null}
      <div className={clsx('p-5', (title || actions) && 'pt-4')}>{children}</div>
    </section>
  )
}

const TILE_TONES = {
  brand: 'bg-brand-50 text-brand-700',
  harvest: 'bg-harvest-100 text-harvest-700',
  sky: 'bg-sky-50 text-sky-800',
  violet: 'bg-violet-50 text-violet-800',
} as const

export function IconTile({
  icon: Icon,
  tone = 'brand',
  className,
}: {
  icon: LucideIcon
  tone?: keyof typeof TILE_TONES
  className?: string
}) {
  return (
    <span
      className={clsx(
        'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
        TILE_TONES[tone],
        className,
      )}
    >
      <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
    </span>
  )
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[28px] leading-tight font-extrabold text-ink">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  )
}

/** The row of filters above a list or chart page. */
export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('surface-card mb-5 grid grid-cols-1 gap-3 p-4', className)}>
      {children}
    </div>
  )
}

const TONES = {
  gray: 'bg-sunken text-ink ring-line-strong/70',
  blue: 'bg-sky-50 text-sky-900 ring-sky-200',
  amber: 'bg-harvest-100 text-amber-900 ring-harvest-300/70',
  green: 'bg-brand-50 text-brand-800 ring-brand-200',
  violet: 'bg-violet-50 text-violet-900 ring-violet-200',
  red: 'bg-red-50 text-red-900 ring-red-200',
} as const

const DOTS: Record<keyof typeof TONES, string> = {
  gray: 'bg-muted',
  blue: 'bg-sky-600',
  amber: 'bg-amber-600',
  green: 'bg-brand-500',
  violet: 'bg-violet-600',
  red: 'bg-red-600',
}

export function Badge({
  tone = 'gray',
  children,
  dot = false,
}: {
  tone?: keyof typeof TONES
  children: ReactNode
  dot?: boolean
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ring-1 ring-inset',
        TONES[tone],
      )}
    >
      {dot ? (
        <span aria-hidden="true" className={clsx('h-1.5 w-1.5 rounded-full', DOTS[tone])} />
      ) : null}
      {children}
    </span>
  )
}

const STATUS_TONES: Record<string, keyof typeof TONES> = {
  draft: 'gray',
  returned: 'amber',
  submitted: 'blue',
  validated: 'violet',
  approved: 'green',
  locked: 'green',
  open: 'green',
  closed: 'gray',
  active: 'green',
  inactive: 'gray',
  needs_review: 'amber',
  ready: 'blue',
  committed: 'green',
  failed: 'red',
  validating: 'amber',
  committing: 'amber',
  uploaded: 'gray',
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge dot tone={STATUS_TONES[status] ?? 'gray'}>
      {STATUS_LABELS[status] ?? status}
    </Badge>
  )
}

const AVATAR_TONES = [
  'bg-brand-100 text-brand-900',
  'bg-harvest-100 text-amber-900',
  'bg-sky-100 text-sky-900',
  'bg-violet-100 text-violet-900',
  'bg-rose-100 text-rose-900',
  'bg-teal-100 text-teal-900',
]

/** Initials in a circle. The same name always gets the same colour. */
export function Avatar({ name, className }: { name: string; className?: string }) {
  const words = name
    .replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const initials = (words.length > 1 ? [words[0], words[words.length - 1]] : words)
    .map((word) => word?.charAt(0) ?? '')
    .join('')
    .toUpperCase()
  const hash = Array.from(name).reduce((sum, char) => sum + (char.codePointAt(0) ?? 0), 0)
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold',
        AVATAR_TONES[hash % AVATAR_TONES.length],
        className,
      )}
    >
      {initials || '?'}
    </span>
  )
}

const ALERTS = {
  info: { cls: 'bg-sky-50 text-sky-950 ring-sky-200', icon: 'text-sky-700', Icon: Info },
  warning: {
    cls: 'bg-harvest-100/70 text-amber-950 ring-harvest-300',
    icon: 'text-amber-700',
    Icon: AlertTriangle,
  },
  error: { cls: 'bg-red-50 text-red-950 ring-red-200', icon: 'text-red-700', Icon: XCircle },
  success: {
    cls: 'bg-brand-50 text-brand-900 ring-brand-200',
    icon: 'text-brand-700',
    Icon: CheckCircle2,
  },
} as const

export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: keyof typeof ALERTS
  title?: ReactNode
  children?: ReactNode
}) {
  const { cls, icon, Icon } = ALERTS[tone]
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={clsx('flex gap-3 rounded-xl p-3.5 text-sm ring-1 ring-inset', cls)}
    >
      <Icon className={clsx('mt-0.5 h-4 w-4 shrink-0', icon)} aria-hidden="true" />
      <div className="min-w-0 space-y-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children}
      </div>
    </div>
  )
}

export function EmptyState({
  title,
  icon: Icon = Inbox,
  children,
}: {
  title: string
  icon?: LucideIcon
  children?: ReactNode
}) {
  return (
    <div className="rounded-2xl border border-dashed border-line-strong bg-surface/50 px-6 py-10 text-center">
      <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-brand-50 text-brand-700">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <p className="font-display font-bold text-ink">{title}</p>
      {children ? <div className="mt-1 text-sm text-muted">{children}</div> : null}
    </div>
  )
}

export function Stat({
  label,
  value,
  hint,
  icon,
  tone,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  icon?: LucideIcon
  tone?: keyof typeof TILE_TONES
}) {
  return (
    <div className="surface-card flex items-start justify-between gap-3 p-5">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-muted">{label}</p>
        <p className="mt-1.5 font-display text-[28px] leading-none font-extrabold text-ink">
          {value}
        </p>
        {hint ? <p className="mt-2 text-[13px] text-muted">{hint}</p> : null}
      </div>
      {icon ? <IconTile icon={icon} {...(tone ? { tone } : {})} /> : null}
    </div>
  )
}

export function DefinitionList({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
      {items.map(([term, value]) => (
        <div key={term}>
          <dt className="text-xs font-medium text-muted">{term}</dt>
          <dd className="mt-0.5 text-sm font-medium text-ink">{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  )
}
