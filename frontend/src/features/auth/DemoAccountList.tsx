import clsx from 'clsx'
import { Eye, EyeOff } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/Button'

import type { DemoAccount } from './demoAccounts'

export function DemoAccountList({
  accounts,
  onUse,
}: {
  accounts: DemoAccount[]
  onUse: (account: DemoAccount) => void
}) {
  const [hidden, setHidden] = useState(false)
  const [chosen, setChosen] = useState<string | null>(null)

  return (
    <section aria-label="Demo accounts" className="mt-7 border-t border-line-strong pt-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold">Demo accounts</h2>
          {hidden ? null : (
            <p className="mt-0.5 text-xs text-muted">One per role. All farmers here are made up.</p>
          )}
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          icon={
            hidden ? (
              <Eye className="h-4 w-4" aria-hidden="true" />
            ) : (
              <EyeOff className="h-4 w-4" aria-hidden="true" />
            )
          }
          onClick={() => {
            setHidden((current) => !current)
          }}
        >
          {hidden ? 'Unhide all' : 'Hide all'}
        </Button>
      </div>
      {hidden ? null : (
        <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {accounts.map((account) => (
            <li
              key={account.email}
              className={clsx(
                'surface-card flex items-center justify-between gap-2 rounded-xl! px-3 py-2 transition',
                chosen === account.email && 'ring-2 ring-brand-600',
              )}
            >
              <div className="min-w-0 text-xs leading-snug">
                <p className="font-semibold text-ink">{account.role}</p>
                <p className="break-all text-muted">{account.email}</p>
                <p className="break-all font-mono text-[11px] text-muted">{account.password}</p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                aria-label={`Use the ${account.role} account`}
                onClick={() => {
                  onUse(account)
                  setChosen(account.email)
                }}
              >
                Use
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
