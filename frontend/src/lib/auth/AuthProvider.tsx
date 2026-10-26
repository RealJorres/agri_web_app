import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import {
  api,
  ensureCsrf,
  onAccessTokenChange,
  readCookie,
  refreshAccessToken,
  setAccessToken,
  unwrap,
  type Schemas,
} from '@/lib/api/client'

import { AuthContext, type AuthState, type Capability } from './context'

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [user, setUser] = useState<Schemas['Me'] | null>(null)
  const [status, setStatus] = useState<AuthState['status']>('loading')

  const loadMe = useCallback(async () => {
    const me = unwrap(await api.GET('/api/v1/auth/me'))
    setUser(me)
    setStatus('authenticated')
  }, [])

  // Restore the session on load from the httpOnly refresh cookie.
  useEffect(() => {
    const run = { cancelled: false }
    void (async () => {
      try {
        const token = await refreshAccessToken()
        if (run.cancelled) return
        if (token) await loadMe()
        else setStatus('anonymous')
      } catch {
        if (!run.cancelled) setStatus('anonymous')
      }
    })()
    return () => {
      run.cancelled = true
    }
  }, [loadMe])

  // A failed refresh anywhere means the session is over.
  useEffect(
    () =>
      onAccessTokenChange((token) => {
        if (token === null) {
          setUser(null)
          setStatus('anonymous')
          queryClient.clear()
        }
      }),
    [queryClient],
  )

  const login = useCallback(async (email: string, password: string) => {
    await ensureCsrf()
    const result = await api.POST('/api/v1/auth/login', {
      body: { email, password },
      headers: { 'X-CSRFToken': readCookie('csrftoken') ?? '' },
    })
    const body = unwrap(result)
    setAccessToken(body.access)
    setUser(body.user)
    setStatus('authenticated')
  }, [])

  const logout = useCallback(async () => {
    try {
      await api.POST('/api/v1/auth/logout')
    } finally {
      setAccessToken(null)
    }
  }, [])

  const value = useMemo<AuthState>(() => {
    const caps = new Set<string>(user?.capabilities ?? [])
    return {
      status,
      user,
      login,
      logout,
      reload: loadMe,
      can: (capability: Capability) => caps.has(capability),
    }
  }, [status, user, login, logout, loadMe])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
