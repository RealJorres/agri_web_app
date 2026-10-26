import clsx from 'clsx'
import { LogOut, Menu, Sprout, X } from 'lucide-react'
import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'

import { useAuth } from '@/lib/auth/context'
import { ROLE_LABELS } from '@/lib/format'

import { NAV_ITEMS } from './navigation'

function scopeLabel(
  assignments: readonly {
    municipality: { name: string } | null
    barangays: readonly unknown[]
  }[],
) {
  if (assignments.length === 0) return 'No assignment'
  if (assignments.some((a) => a.municipality === null)) return 'All municipalities'
  const towns = [...new Set(assignments.map((a) => a.municipality?.name ?? ''))]
  const limited = assignments.some((a) => a.barangays.length > 0) ? ' (selected barangays)' : ''
  return towns.join(', ') + limited
}

export function AppShell() {
  const { user, can, logout } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()
  const [lastPath, setLastPath] = useState(location.pathname)
  if (lastPath !== location.pathname) {
    // Close the mobile menu after navigating (adjust state during render, no effect needed).
    setLastPath(location.pathname)
    setMenuOpen(false)
  }
  if (!user) return null

  const items = NAV_ITEMS.filter((item) => item.anyOf.some((cap) => can(cap)))
  const roles = user.roles.map((r) => ROLE_LABELS[r] ?? r).join(', ')

  const nav = (
    <nav aria-label="Main" className="flex flex-col gap-1 p-3">
      {items.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          className={({ isActive }) =>
            clsx(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium',
              isActive ? 'bg-brand-700 text-white' : 'text-slate-200 hover:bg-brand-800',
            )
          }
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
          {label}
        </NavLink>
      ))}
      {can('admin') ? (
        <a
          href="/admin/"
          className="mt-4 rounded-md px-3 py-2 text-sm text-slate-300 hover:bg-brand-800"
        >
          Django admin ↗
        </a>
      ) : null}
    </nav>
  )

  return (
    <div className="min-h-screen md:grid md:grid-cols-[15rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <aside className="hidden bg-brand-900 md:block">
        <div className="flex items-center gap-2 px-5 py-4 text-white">
          <Sprout className="h-6 w-6" aria-hidden="true" />
          <span className="font-semibold">agri-dms</span>
        </div>
        {nav}
      </aside>

      {menuOpen ? (
        <div
          className="fixed inset-0 z-40 md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
        >
          <button
            type="button"
            className="absolute inset-0 bg-slate-900/50"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
          />
          <aside className="relative h-full w-64 bg-brand-900">
            <div className="flex items-center justify-between px-5 py-4 text-white">
              <span className="font-semibold">agri-dms</span>
              <button type="button" onClick={() => setMenuOpen(false)} aria-label="Close menu">
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            {nav}
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3">
          <button
            type="button"
            className="rounded p-1.5 text-ink hover:bg-slate-100 md:hidden"
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
          <div className="min-w-0 flex-1 md:flex-none">
            <p className="truncate text-sm font-medium text-ink">{user.full_name || user.email}</p>
            <p className="truncate text-xs text-muted">
              {roles || 'No role'} ·{' '}
              {user.is_superuser ? 'All municipalities' : scopeLabel(user.assignments)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void logout()}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-ink hover:bg-slate-100"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </header>
        <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
