import { zodResolver } from '@hookform/resolvers/zod'
import { Sprout } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { z } from 'zod'

import { Button } from '@/components/ui/Button'
import { Alert } from '@/components/ui/display'
import { TextInput } from '@/components/ui/fields'
import { ApiError } from '@/lib/api/client'
import { useAuth } from '@/lib/auth/context'

import { parseDemoAccounts } from './demoAccounts'

const schema = z.object({
  email: z.email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
})
type Values = z.infer<typeof schema>

const DEMO_ACCOUNTS = parseDemoAccounts(import.meta.env.VITE_DEMO_ACCOUNTS)

export default function LoginPage() {
  const { status, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [error, setError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) })

  const from = (location.state as { from?: string } | null)?.from ?? '/'
  if (status === 'authenticated') return <Navigate to={from} replace />

  const onSubmit = handleSubmit(async (values) => {
    setError(null)
    try {
      await login(values.email, values.password)
      await navigate(from, { replace: true })
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Cannot reach the server. Check your connection.',
      )
    }
  })

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2 text-brand-800">
          <Sprout className="h-8 w-8" aria-hidden="true" />
          <span className="text-xl font-semibold">agri-dms</span>
        </div>
        <div className="rounded-lg border border-line bg-surface p-6 shadow-sm">
          <h1 className="text-lg font-semibold">Sign in</h1>
          <p className="mt-1 text-sm text-muted">Marinduque Provincial Agriculture Office</p>
          <form className="mt-5 space-y-4" onSubmit={(e) => void onSubmit(e)} noValidate>
            {error ? <Alert tone="error">{error}</Alert> : null}
            <TextInput
              label="Email"
              type="email"
              autoComplete="username"
              required
              error={errors.email?.message}
              {...register('email')}
            />
            <TextInput
              label="Password"
              type="password"
              autoComplete="current-password"
              required
              error={errors.password?.message}
              {...register('password')}
            />
            <Button type="submit" className="w-full" loading={isSubmitting}>
              Sign in
            </Button>
          </form>
        </div>
        {DEMO_ACCOUNTS.length > 0 ? (
          <section
            aria-label="Demo accounts"
            className="mt-4 rounded-lg border border-line bg-surface p-4 shadow-sm"
          >
            <h2 className="text-sm font-semibold">Demo accounts</h2>
            <p className="mt-1 text-xs text-muted">One per role. All farmers here are made up.</p>
            <ul className="mt-2 divide-y divide-line">
              {DEMO_ACCOUNTS.map((account) => (
                <li key={account.email} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0 text-xs">
                    <p className="font-medium text-ink">{account.role}</p>
                    <p className="break-all text-muted">{account.email}</p>
                    <p className="break-all font-mono text-muted">{account.password}</p>
                  </div>
                  <Button
                    variant="secondary"
                    aria-label={`Use the ${account.role} account`}
                    onClick={() => {
                      setValue('email', account.email, { shouldValidate: true })
                      setValue('password', account.password, { shouldValidate: true })
                    }}
                  >
                    Use
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </main>
  )
}
