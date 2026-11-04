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
const MapPage = lazy(() => import('@/features/map/MapPage'))
const FarmersPage = lazy(() => import('@/features/farmers/FarmersPage'))
const FarmerDetailPage = lazy(() => import('@/features/farmers/FarmerDetailPage'))
const FarmerFormPage = lazy(() => import('@/features/farmers/FarmerFormPage'))
const AssociationsPage = lazy(() => import('@/features/associations/AssociationsPage'))
const AssociationDetailPage = lazy(() => import('@/features/associations/AssociationDetailPage'))
const RoundsPage = lazy(() => import('@/features/surveys/RoundsPage'))
const RoundDetailPage = lazy(() => import('@/features/surveys/RoundDetailPage'))
const InventoryEntryPage = lazy(() => import('@/features/surveys/InventoryEntryPage'))
const NewEntryPage = lazy(() => import('@/features/surveys/NewEntryPage'))
const ReviewQueuePage = lazy(() => import('@/features/review/ReviewQueuePage'))
const ImportsPage = lazy(() => import('@/features/imports/ImportsPage'))
const ImportDetailPage = lazy(() => import('@/features/imports/ImportDetailPage'))
const UsersPage = lazy(() => import('@/features/admin/UsersPage'))
const UserDetailPage = lazy(() => import('@/features/admin/UserDetailPage'))
const CropsPage = lazy(() => import('@/features/admin/CropsPage'))
const CropDetailPage = lazy(() => import('@/features/admin/CropDetailPage'))
const SourcesPage = lazy(() => import('@/features/admin/SourcesPage'))
const ReportSettingsPage = lazy(() => import('@/features/admin/ReportSettingsPage'))

const page = (element: ReactNode) => <Suspense fallback={<LoadingBlock />}>{element}</Suspense>
const adminPage = (element: ReactNode) => (
  <RequireCapability anyOf={['admin']}>{page(element)}</RequireCapability>
)

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
          { path: 'map', element: page(<MapPage />) },
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
          {
            path: 'inventory/entry',
            element: (
              <RequireCapability anyOf={['edit_records']}>
                {page(<NewEntryPage />)}
              </RequireCapability>
            ),
          },
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
          { path: 'admin/users', element: adminPage(<UsersPage />) },
          { path: 'admin/users/:id', element: adminPage(<UserDetailPage />) },
          { path: 'admin/crops', element: adminPage(<CropsPage />) },
          { path: 'admin/crops/:id', element: adminPage(<CropDetailPage />) },
          { path: 'admin/sources', element: adminPage(<SourcesPage />) },
          { path: 'admin/reports', element: adminPage(<ReportSettingsPage />) },
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
