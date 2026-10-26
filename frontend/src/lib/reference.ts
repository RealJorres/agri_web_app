import { useQuery } from '@tanstack/react-query'

import { api, unwrap } from '@/lib/api/client'

const STALE = 10 * 60 * 1000 // reference data changes rarely

export function useMunicipalities() {
  return useQuery({
    queryKey: ['municipalities'],
    queryFn: async () => unwrap(await api.GET('/api/v1/municipalities')),
    staleTime: STALE,
  })
}

export function useBarangays(municipality?: string) {
  return useQuery({
    queryKey: ['barangays', municipality ?? 'all'],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/barangays', {
          params: { query: municipality ? { municipality } : {} },
        }),
      ),
    staleTime: STALE,
  })
}

export function useCommodities() {
  return useQuery({
    queryKey: ['commodities'],
    queryFn: async () => unwrap(await api.GET('/api/v1/commodities')),
    staleTime: STALE,
  })
}

export function useRounds(filters: { commodity?: string; status?: 'open' | 'closed' } = {}) {
  return useQuery({
    queryKey: ['survey-rounds', filters],
    queryFn: async () =>
      unwrap(await api.GET('/api/v1/survey-rounds', { params: { query: filters } })),
  })
}
