import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api, unwrap } from '@/lib/api/client'

import type { AreaLevel, LonLat } from './geo'

export function useMapConfig() {
  return useQuery({
    queryKey: ['map', 'config'],
    queryFn: async () => unwrap(await api.GET('/api/v1/map/config')),
    staleTime: 10 * 60 * 1000,
  })
}

export function useBoundaries(level: AreaLevel, municipality: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['map', 'boundaries', level, municipality ?? null],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/map/boundaries', {
          params: { query: { level, ...(municipality ? { municipality } : {}) } },
        }),
      ),
    staleTime: 10 * 60 * 1000,
    enabled,
  })
}

export function useAreaFigures(
  round: string | undefined,
  level: AreaLevel,
  municipality: string | undefined,
) {
  return useQuery({
    queryKey: ['analytics', 'map-breakdown', round, level, municipality ?? null],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/analytics/rounds/{id}/breakdown', {
          params: {
            path: { id: round ?? '' },
            query: { level, ...(municipality ? { municipality } : {}) },
          },
        }),
      ),
    enabled: Boolean(round),
  })
}

/** Personal data: only requested for roles with view_personal_data (the server enforces it). */
export function useFarmPoints(municipality: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['map', 'points', municipality ?? null],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/farms/points', {
          params: { query: municipality ? { municipality } : {} },
        }),
      ),
    enabled,
  })
}

export function useSetFarmLocation(farmer: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (args: { farm: string; location: LonLat | null }) =>
      unwrap(
        await api.PATCH('/api/v1/farms/{id}', {
          params: { path: { id: args.farm } },
          body: { location: args.location },
        }),
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['farms', { farmer }] }),
        queryClient.invalidateQueries({ queryKey: ['map', 'points'] }),
      ])
    },
  })
}
