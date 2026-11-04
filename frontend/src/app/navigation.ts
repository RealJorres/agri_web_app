import {
  BarChart3,
  ClipboardCheck,
  ClipboardPen,
  FileSignature,
  FileUp,
  Home,
  Layers,
  Map as MapIcon,
  PackageOpen,
  Sprout,
  UserCog,
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
  group: 'Overview' | 'Records' | 'Administration'
}

export const NAV_GROUPS = ['Overview', 'Records', 'Administration'] as const

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Home', icon: Home, anyOf: ['view_aggregates'], group: 'Overview' },
  {
    to: '/dashboard',
    label: 'Dashboard',
    icon: BarChart3,
    anyOf: ['view_aggregates'],
    group: 'Overview',
  },
  { to: '/map', label: 'Map', icon: MapIcon, anyOf: ['view_aggregates'], group: 'Overview' },
  {
    to: '/inventory/entry',
    label: 'New entry',
    icon: ClipboardPen,
    anyOf: ['edit_records'],
    group: 'Records',
  },
  { to: '/farmers', label: 'Farmers', icon: Users, anyOf: ['view_records'], group: 'Records' },
  {
    to: '/associations',
    label: 'Associations',
    icon: UsersRound,
    anyOf: ['view_records'],
    group: 'Records',
  },
  {
    to: '/rounds',
    label: 'Survey rounds',
    icon: Layers,
    anyOf: ['view_aggregates'],
    group: 'Records',
  },
  {
    to: '/review',
    label: 'Review queue',
    icon: ClipboardCheck,
    anyOf: ['validate', 'approve'],
    group: 'Records',
  },
  { to: '/imports', label: 'Imports', icon: FileUp, anyOf: ['run_imports'], group: 'Records' },
  { to: '/admin/users', label: 'Users', icon: UserCog, anyOf: ['admin'], group: 'Administration' },
  { to: '/admin/crops', label: 'Crops', icon: Sprout, anyOf: ['admin'], group: 'Administration' },
  {
    to: '/admin/sources',
    label: 'Material sources',
    icon: PackageOpen,
    anyOf: ['admin'],
    group: 'Administration',
  },
  {
    to: '/admin/reports',
    label: 'Report settings',
    icon: FileSignature,
    anyOf: ['admin'],
    group: 'Administration',
  },
]
