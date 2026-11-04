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

/** A grey placeholder bar, so a page keeps its shape while it loads. */
export function Skeleton({ className }: { className?: string }) {
  return <span className={clsx('block animate-shimmer rounded-md bg-line', className)} />
}

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" className="grid gap-4 py-2 sm:grid-cols-3">
      <span className="sr-only">{label}</span>
      {[0, 1, 2].map((i) => (
        <span key={i} aria-hidden="true" className="surface-card block space-y-3 p-5">
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="h-7 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </span>
      ))}
    </div>
  )
}
