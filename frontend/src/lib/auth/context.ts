import { createContext, useContext } from 'react'

import type { Schemas } from '@/lib/api/client'

/** Mirrors apps/accounts/roles.py Cap. The UI hides what you cannot do; the API enforces it. */
export type Capability =
  | 'view_aggregates'
  | 'view_records'
  | 'view_personal_data'
  | 'edit_records'
  | 'submit'
  | 'validate'
  | 'approve'
  | 'reopen'
  | 'manage_rounds'
  | 'run_imports'
  | 'merge_farmers'
  | 'export_personal_data'
  | 'sign_reports'
  | 'admin'

export interface AuthState {
  status: 'loading' | 'authenticated' | 'anonymous'
  user: Schemas['Me'] | null
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  reload: () => Promise<void>
  can: (capability: Capability) => boolean
}

export const AuthContext = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>')
  return value
}
