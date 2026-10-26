import type { ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router'

import { EmptyState } from '@/components/ui/display'
import { LoadingBlock } from '@/components/ui/Spinner'
import { useAuth, type Capability } from '@/lib/auth/context'

export function RequireAuth() {
  const { status } = useAuth()
  const location = useLocation()
  if (status === 'loading') return <LoadingBlock label="Checking your session…" />
  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }
  return <Outlet />
}

/** UX only: hides pages the user cannot use. The API enforces the same rule server-side. */
export function RequireCapability({
  anyOf,
  children,
}: {
  anyOf: Capability[]
  children: ReactNode
}) {
  const { can } = useAuth()
  if (!anyOf.some((cap) => can(cap))) {
    return (
      <EmptyState title="Not available for your role">
        Ask a system administrator if you need access to this page.
      </EmptyState>
    )
  }
  return <>{children}</>
}
