import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api, unwrap, type Schemas } from '@/lib/api/client'

export type InventoryRecord = Schemas['InventoryRecord']
export type WorkflowAction = 'submit' | 'validate' | 'approve' | 'return' | 'reopen'

export function useRecord(id: string | undefined) {
  return useQuery({
    queryKey: ['inventory-record', id],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/inventory-records/{id}', { params: { path: { id: id ?? '' } } }),
      ),
    enabled: Boolean(id),
  })
}

export function useComments(id: string) {
  return useQuery({
    queryKey: ['inventory-record', id, 'comments'],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/inventory-records/{id}/comments', { params: { path: { id } } }),
      ),
  })
}

export function useStages(commodity: string | undefined) {
  return useQuery({
    queryKey: ['stages', commodity],
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/commodities/{id}/stages', {
          params: { path: { id: commodity ?? '' } },
        }),
      ),
    enabled: Boolean(commodity),
    staleTime: 10 * 60 * 1000,
  })
}

const ACTION_PATHS = {
  submit: '/api/v1/inventory-records/{id}/submit',
  validate: '/api/v1/inventory-records/{id}/validate',
  approve: '/api/v1/inventory-records/{id}/approve',
  return: '/api/v1/inventory-records/{id}/return',
  reopen: '/api/v1/inventory-records/{id}/reopen',
} as const

export function useTransition() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      id,
      action,
      comment,
    }: {
      id: string
      action: WorkflowAction
      comment: string
    }) =>
      unwrap(
        await api.POST(ACTION_PATHS[action], {
          params: { path: { id } },
          body: comment ? { comment } : {},
        }),
      ),
    onSuccess: async (record) => {
      queryClient.setQueryData(['inventory-record', record.id], record)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['inventory-records'] }),
        queryClient.invalidateQueries({ queryKey: ['inventory-record', record.id, 'comments'] }),
        queryClient.invalidateQueries({ queryKey: ['stats'] }),
      ])
    },
  })
}
