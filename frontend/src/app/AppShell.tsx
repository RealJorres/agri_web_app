import clsx from 'clsx'
import { LogOut, Menu, Sprout, X } from 'lucide-react'
import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'

import { Avatar } from '@/components/ui/display'
import { useAuth } from '@/lib/auth/context'
import { ROLE_LABELS } from '@/lib/format'

import { NAV_GROUPS, NAV_ITEMS } from './navigation'

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

function Brand() {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-harvest-300 text-brand-950 shadow-sm">
        <Sprout className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block font-display text-[15px] font-extrabold tracking-tight text-white">
          agri-dms
        </span>
        <span className="block truncate text-[11px] text-brand-200">Marinduque PAO</span>
      </span>
    </div>
  )
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
  const name = user.full_name || user.email

  const nav = (
    <nav aria-label="Main" className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
      {NAV_GROUPS.map((group) => {
        const links = items.filter((item) => item.group === group)
        if (links.length === 0) return null
        return (
          <div key={group}>
            <p className="mb-1.5 px-3 text-[11px] font-semibold text-brand-100">{group}</p>
            <div className="space-y-0.5">
              {links.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={to === '/'}
                  className={({ isActive }) =>
                    clsx(
                      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition',
                      'focus-visible:outline-white',
                      isActive
                        ? 'bg-white text-brand-900 shadow-sm'
                        : 'text-brand-100 hover:bg-white/10 hover:text-white',
                    )
                  }
                >
                  <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
                  {label}
                </NavLink>
              ))}
            </div>
          </div>
        )
      })}
    </nav>
  )

  return (
    <div className="min-h-screen md:grid md:grid-cols-[16rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <aside className="surface-forest sticky top-0 hidden h-screen flex-col md:flex">
        <div className="px-5 pt-5 pb-6">
          <Brand />
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
            className="absolute inset-0 bg-brand-950/50 backdrop-blur-xs"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
          />
          <aside className="surface-forest relative flex h-full w-72 max-w-[85%] animate-rise flex-col shadow-overlay">
            <div className="flex items-center justify-between gap-2 px-5 pt-5 pb-6">
              <Brand />
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                aria-label="Close menu"
                className="rounded-lg p-1 text-white hover:bg-white/10"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            {nav}
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-line/80 bg-canvas/85 px-4 py-2.5 backdrop-blur-md sm:px-8">
          <button
            type="button"
            className="rounded-lg p-1.5 text-ink hover:bg-line/60 md:hidden"
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
          <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
            <Avatar name={name} className="bg-brand-700! text-white!" />
            <div className="min-w-0 text-right sm:text-left">
              <p className="truncate text-sm font-semibold text-ink">{name}</p>
              <p className="truncate text-xs text-muted">
                {roles || 'No role'} ·{' '}
                {user.is_superuser ? 'All municipalities' : scopeLabel(user.assignments)}
              </p>
            </div>
            <span aria-hidden="true" className="mx-1 hidden h-6 w-px bg-line-strong sm:block" />
            <button
              type="button"
              onClick={() => void logout()}
              aria-label="Sign out"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted transition hover:bg-line/60 hover:text-ink"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </header>
        <main
          key={location.pathname}
          id="main"
          className="mx-auto w-full max-w-7xl flex-1 animate-rise px-4 py-7 sm:px-8"
        >
          <Outlet />
        </main>
      </div>
    </div>
  )
}
