import {
  BarChart3,
  ClipboardCheck,
  FileUp,
  Home,
  Layers,
  Users,
  UsersRound,
  type LucideIcon,
} from 'lucide-react'

import type { Capability } from '@/lib/auth/context'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  /** Shown when the user has ANY of these capabilities. */
  anyOf: Capability[]
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Home', icon: Home, anyOf: ['view_aggregates'] },
  { to: '/dashboard', label: 'Dashboard', icon: BarChart3, anyOf: ['view_aggregates'] },
  { to: '/farmers', label: 'Farmers', icon: Users, anyOf: ['view_records'] },
  { to: '/associations', label: 'Associations', icon: UsersRound, anyOf: ['view_records'] },
  { to: '/rounds', label: 'Survey rounds', icon: Layers, anyOf: ['view_aggregates'] },
  { to: '/review', label: 'Review queue', icon: ClipboardCheck, anyOf: ['validate', 'approve'] },
  { to: '/imports', label: 'Imports', icon: FileUp, anyOf: ['run_imports'] },
]
