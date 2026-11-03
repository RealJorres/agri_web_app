import { useQuery } from '@tanstack/react-query'

import { api, unwrap } from '@/lib/api/client'

export function usePrograms() {
  return useQuery({
    queryKey: ['programs'],
    queryFn: async () => unwrap(await api.GET('/api/v1/programs')),
  })
}

export const MEASURE_LABELS: Record<string, string> = {
  trees: 'Counted by trees',
  area: 'Measured by area',
}

/** Import spellings are typed one per line. */
export function aliasesFromText(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

export const ALIASES_HINT =
  'Other spellings used in workbooks, one per line. Imports match these exactly, so a spelling not ' +
  'listed here goes to the review list.'
