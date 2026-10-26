import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api, unwrap, type Schemas } from '@/lib/api/client'

export type Farmer = Schemas['Farmer']
export type FarmerDetail = Schemas['FarmerDetail']
export type FarmerInput = Schemas['FarmerWriteRequest']

export interface FarmerListParams {
  page?: number
  ordering?: string
  q?: string
  municipality?: string
  barangay?: string
  association?: string
  status?: 'active' | 'inactive' | 'needs_review'
}

export function useFarmers(params: FarmerListParams) {
  return useQuery({
    queryKey: ['farmers', params],
    queryFn: async () => unwrap(await api.GET('/api/v1/farmers', { params: { query: params } })),
    placeholderData: keepPreviousData,
  })
}

export function useFarmer(id: string | undefined) {
  return useQuery({
    queryKey: ['farmer', id],
    queryFn: async () =>
      unwrap(await api.GET('/api/v1/farmers/{id}', { params: { path: { id: id ?? '' } } })),
    enabled: Boolean(id),
  })
}

export function useFarmerAudit(id: string) {
  return useQuery({
    queryKey: ['farmer', id, 'audit'],
    queryFn: async () =>
      unwrap(await api.GET('/api/v1/farmers/{id}/audit', { params: { path: { id } } })),
  })
}

export function useFarmsOf(farmer: string) {
  return useQuery({
    queryKey: ['farms', { farmer }],
    queryFn: async () => unwrap(await api.GET('/api/v1/farms', { params: { query: { farmer } } })),
  })
}

export function useRecordsOf(farmer: string) {
  return useQuery({
    queryKey: ['inventory-records', { farmer }],
    queryFn: async () =>
      unwrap(await api.GET('/api/v1/inventory-records', { params: { query: { farmer } } })),
  })
}

export function useDuplicates(args: { name: string; barangay?: string; exclude?: string }) {
  const enabled = args.name.trim().length >= 4
  return useQuery({
    queryKey: ['farmer-duplicates', args],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/farmers/duplicates', {
          params: {
            query: {
              name: args.name,
              ...(args.barangay ? { barangay: args.barangay } : {}),
              ...(args.exclude ? { exclude: args.exclude } : {}),
            },
          },
        }),
      ),
    enabled,
    staleTime: 60_000,
  })
}

export function useSaveFarmer(id?: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (body: FarmerInput) =>
      id
        ? unwrap(await api.PATCH('/api/v1/farmers/{id}', { params: { path: { id } }, body }))
        : unwrap(await api.POST('/api/v1/farmers', { body })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['farmers'] })
      if (id) await queryClient.invalidateQueries({ queryKey: ['farmer', id] })
    },
  })
}

export function useCreateFarm(farmer: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (args: { barangay: string; sitio: string; commodity: string }) => {
      const farm = unwrap(
        await api.POST('/api/v1/farms', {
          body: { farmer, barangay: args.barangay, sitio: args.sitio },
        }),
      )
      unwrap(
        await api.POST('/api/v1/farms/{id}/crop-stands', {
          params: { path: { id: farm.id } },
          body: { commodity: args.commodity },
        }),
      )
      return farm
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['farms', { farmer }] })
    },
  })
}
