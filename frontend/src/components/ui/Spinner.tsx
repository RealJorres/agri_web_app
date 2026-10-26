import clsx from 'clsx'

export function Spinner({ size = 'md', label }: { size?: 'sm' | 'md'; label?: string }) {
  return (
    <span role={label ? 'status' : undefined} className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className={clsx(
          'inline-block animate-spin rounded-full border-2 border-current border-r-transparent',
          size === 'sm' ? 'h-4 w-4' : 'h-6 w-6',
        )}
      />
      {label ? <span className="text-sm text-muted">{label}</span> : null}
    </span>
  )
}

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex justify-center py-12 text-brand-700">
      <Spinner label={label} />
    </div>
  )
}
