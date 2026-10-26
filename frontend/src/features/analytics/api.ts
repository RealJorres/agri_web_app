import { useQuery } from '@tanstack/react-query'

import { api, unwrap } from '@/lib/api/client'

export function useAnalyticsStatus() {
  return useQuery({
    queryKey: ['analytics', 'status'],
    queryFn: async () => unwrap(await api.GET('/api/v1/analytics/status')),
  })
}

export function useOverview(round: string | undefined, municipality?: string) {
  return useQuery({
    queryKey: ['analytics', 'overview', round, municipality ?? null],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/analytics/rounds/{id}/overview', {
          params: { path: { id: round ?? '' }, query: municipality ? { municipality } : {} },
        }),
      ),
    enabled: Boolean(round),
  })
}

export function useBreakdown(round: string | undefined, municipality?: string) {
  return useQuery({
    queryKey: ['analytics', 'breakdown', round, municipality ?? null],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/analytics/rounds/{id}/breakdown', {
          params: {
            path: { id: round ?? '' },
            query: municipality ? { level: 'barangay', municipality } : { level: 'municipality' },
          },
        }),
      ),
    enabled: Boolean(round),
  })
}

export function useDistribution(round: string | undefined, municipality?: string) {
  return useQuery({
    queryKey: ['analytics', 'distribution', round, municipality ?? null],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/analytics/rounds/{id}/distribution', {
          params: { path: { id: round ?? '' }, query: municipality ? { municipality } : {} },
        }),
      ),
    enabled: Boolean(round),
  })
}

export function useTrends(commodity: string | undefined, municipality?: string) {
  return useQuery({
    queryKey: ['analytics', 'trends', commodity, municipality ?? null],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/analytics/trends', {
          params: {
            query: { commodity: commodity ?? '', ...(municipality ? { municipality } : {}) },
          },
        }),
      ),
    enabled: Boolean(commodity),
  })
}
