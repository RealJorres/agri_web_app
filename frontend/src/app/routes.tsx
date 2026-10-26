import { QueryClient } from '@tanstack/react-query'
import { lazy, Suspense, type ReactNode } from 'react'
import type { RouteObject } from 'react-router'

import { LoadingBlock } from '@/components/ui/Spinner'
import { ApiError } from '@/lib/api/client'

import { AppShell } from './AppShell'
import { RequireAuth, RequireCapability } from './guards'

const LoginPage = lazy(() => import('@/features/auth/LoginPage'))
const HomePage = lazy(() => import('@/features/home/HomePage'))
const DashboardPage = lazy(() => import('@/features/analytics/DashboardPage'))
const FarmersPage = lazy(() => import('@/features/farmers/FarmersPage'))
const FarmerDetailPage = lazy(() => import('@/features/farmers/FarmerDetailPage'))
const FarmerFormPage = lazy(() => import('@/features/farmers/FarmerFormPage'))
const AssociationsPage = lazy(() => import('@/features/associations/AssociationsPage'))
const AssociationDetailPage = lazy(() => import('@/features/associations/AssociationDetailPage'))
const RoundsPage = lazy(() => import('@/features/surveys/RoundsPage'))
const RoundDetailPage = lazy(() => import('@/features/surveys/RoundDetailPage'))
const InventoryEntryPage = lazy(() => import('@/features/surveys/InventoryEntryPage'))
const ReviewQueuePage = lazy(() => import('@/features/review/ReviewQueuePage'))
const ImportsPage = lazy(() => import('@/features/imports/ImportsPage'))
const ImportDetailPage = lazy(() => import('@/features/imports/ImportDetailPage'))

const page = (element: ReactNode) => <Suspense fallback={<LoadingBlock />}>{element}</Suspense>

export const routes: RouteObject[] = [
  { path: '/login', element: page(<LoginPage />) },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: page(<HomePage />) },
          { path: 'dashboard', element: page(<DashboardPage />) },
          {
            path: 'farmers',
            element: (
              <RequireCapability anyOf={['view_records']}>
                {page(<FarmersPage />)}
              </RequireCapability>
            ),
          },
          { path: 'farmers/new', element: page(<FarmerFormPage />) },
          { path: 'farmers/:id', element: page(<FarmerDetailPage />) },
          { path: 'farmers/:id/edit', element: page(<FarmerFormPage />) },
          {
            path: 'associations',
            element: (
              <RequireCapability anyOf={['view_records']}>
                {page(<AssociationsPage />)}
              </RequireCapability>
            ),
          },
          { path: 'associations/:id', element: page(<AssociationDetailPage />) },
          { path: 'rounds', element: page(<RoundsPage />) },
          { path: 'rounds/:id', element: page(<RoundDetailPage />) },
          { path: 'inventory/new', element: page(<InventoryEntryPage />) },
          { path: 'inventory/:id', element: page(<InventoryEntryPage />) },
          {
            path: 'review',
            element: (
              <RequireCapability anyOf={['validate', 'approve']}>
                {page(<ReviewQueuePage />)}
              </RequireCapability>
            ),
          },
          {
            path: 'imports',
            element: (
              <RequireCapability anyOf={['run_imports']}>{page(<ImportsPage />)}</RequireCapability>
            ),
          },
          { path: 'imports/:id', element: page(<ImportDetailPage />) },
        ],
      },
    ],
  },
]

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // Never retry client errors (403/404/400); one retry for network/server errors.
        retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 1,
      },
    },
  })
}
