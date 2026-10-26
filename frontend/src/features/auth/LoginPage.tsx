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

const schema = z.object({
  email: z.email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
})
type Values = z.infer<typeof schema>

export default function LoginPage() {
  const { status, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [error, setError] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
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
      </div>
    </main>
  )
}
