import { zodResolver } from '@hookform/resolvers/zod'
import { BadgeCheck, ClipboardPen, Landmark, Sprout, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { z } from 'zod'

import { Button } from '@/components/ui/Button'
import { Alert } from '@/components/ui/display'
import { TextInput } from '@/components/ui/fields'
import { ApiError } from '@/lib/api/client'
import { useAuth } from '@/lib/auth/context'

import { DemoAccountList } from './DemoAccountList'
import { parseDemoAccounts } from './demoAccounts'

const schema = z.object({
  email: z.email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
})
type Values = z.infer<typeof schema>

const DEMO_ACCOUNTS = parseDemoAccounts(import.meta.env.VITE_DEMO_ACCOUNTS)

const STEPS: { icon: LucideIcon; label: string; who: string }[] = [
  { icon: ClipboardPen, label: 'Encoded', who: 'Field or office' },
  { icon: BadgeCheck, label: 'Validated', who: 'Municipal office' },
  { icon: Landmark, label: 'Approved', who: 'Province' },
]

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
    <div className="min-h-screen lg:grid lg:grid-cols-[minmax(24rem,5fr)_7fr]">
      <aside className="surface-forest relative hidden flex-col justify-between overflow-hidden p-10 lg:flex">
        <Sprout
          aria-hidden="true"
          strokeWidth={0.6}
          className="pointer-events-none absolute -right-20 -bottom-16 h-[26rem] w-[26rem] text-white/[0.07]"
        />
        <div className="relative flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-harvest-300 text-brand-950">
            <Sprout className="h-5 w-5" aria-hidden="true" />
          </span>
          <span className="font-display text-lg font-extrabold">agri-dms</span>
        </div>
        <div className="relative max-w-md">
          <p className="font-display text-[34px] leading-[1.15] font-extrabold tracking-tight">
            One farmer record, from the field to the province.
          </p>
          <ol className="mt-8 flex items-start">
            {STEPS.map(({ icon: Icon, label, who }, i) => (
              <li key={label} className="relative flex-1">
                {i < STEPS.length - 1 ? (
                  <span
                    aria-hidden="true"
                    className="absolute top-5 left-10 h-px w-[calc(100%-2.5rem)] bg-white/25"
                  />
                ) : null}
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 ring-1 ring-inset ring-white/20">
                  <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
                </span>
                <span className="mt-2.5 block text-sm font-semibold">{label}</span>
                <span className="block text-xs text-brand-100">{who}</span>
              </li>
            ))}
          </ol>
        </div>
        <p className="relative text-xs text-brand-100">Marinduque Provincial Agriculture Office</p>
      </aside>

      <main className="flex min-h-screen items-center justify-center px-4 py-8 lg:min-h-0">
        <div className="w-full max-w-xl animate-rise">
          <div className="mx-auto w-full max-w-sm">
            <div className="mb-6 flex items-center gap-2.5 text-brand-800 lg:hidden">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-900 text-harvest-300">
                <Sprout className="h-5 w-5" aria-hidden="true" />
              </span>
              <span className="font-display text-lg font-extrabold">agri-dms</span>
            </div>
            <h1 className="text-[28px] leading-tight font-extrabold">Sign in</h1>
            <p className="mt-1 text-sm text-muted lg:hidden">
              Marinduque Provincial Agriculture Office
            </p>
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
            <DemoAccountList
              accounts={DEMO_ACCOUNTS}
              onUse={(account) => {
                setValue('email', account.email, { shouldValidate: true })
                setValue('password', account.password, { shouldValidate: true })
              }}
            />
          ) : null}
        </div>
      </main>
    </div>
  )
}
