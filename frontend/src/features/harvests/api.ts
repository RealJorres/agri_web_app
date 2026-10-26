import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api, unwrap, type Schemas } from '@/lib/api/client'

export type Harvest = Schemas['Harvest']
export type HarvestInput = Schemas['HarvestRequest']
export type HarvestSummary = Schemas['HarvestSummary']

const key = (stand: string) => ['crop-stand', stand, 'harvests'] as const

export function useHarvests(stand: string) {
  return useQuery({
    queryKey: key(stand),
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/crop-stands/{id}/harvests', { params: { path: { id: stand } } }),
      ),
  })
}

/** Create (no id) or update (id) a harvest; refreshes the stand's list and the summary. */
export function useSaveHarvest(stand: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, body }: { id?: string; body: HarvestInput }) =>
      id
        ? unwrap(await api.PATCH('/api/v1/harvests/{id}', { params: { path: { id } }, body }))
        : unwrap(
            await api.POST('/api/v1/crop-stands/{id}/harvests', {
              params: { path: { id: stand } },
              body,
            }),
          ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: key(stand) })
      await queryClient.invalidateQueries({ queryKey: ['harvest-summary'] })
    },
  })
}

export function useDeleteHarvest(stand: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.DELETE('/api/v1/harvests/{id}', { params: { path: { id } } })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: key(stand) })
      await queryClient.invalidateQueries({ queryKey: ['harvest-summary'] })
    },
  })
}

export function useHarvestSummary(params: { commodity?: string; year?: number }) {
  return useQuery({
    queryKey: ['harvest-summary', params],
    queryFn: async () =>
      unwrap(await api.GET('/api/v1/analytics/harvests', { params: { query: params } })),
    placeholderData: keepPreviousData,
  })
}
