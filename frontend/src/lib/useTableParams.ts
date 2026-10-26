import type { SortingState } from '@tanstack/react-table'
import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router'

/** Table state (page, sort, filters) lives in the URL so views are shareable and survive reload. */
export function useTableParams(filterKeys: readonly string[]) {
  const [params, setParams] = useSearchParams()

  const page = Math.max(1, Number(params.get('page') ?? '1') || 1)
  const ordering = params.get('ordering') ?? ''
  const sorting: SortingState = useMemo(
    () => (ordering ? [{ id: ordering.replace(/^-/, ''), desc: ordering.startsWith('-') }] : []),
    [ordering],
  )
  const filters = useMemo(() => {
    const out: Record<string, string> = {}
    for (const key of filterKeys) {
      const value = params.get(key)
      if (value) out[key] = value
    }
    return out
  }, [params, filterKeys])

  const update = useCallback(
    (changes: Record<string, string | null>, resetPage = true) => {
      setParams((current) => {
        const next = new URLSearchParams(current)
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value)
          else next.delete(key)
        }
        if (resetPage && !('page' in changes)) next.delete('page')
        return next
      })
    },
    [setParams],
  )

  const setPage = useCallback(
    (p: number) => {
      update({ page: p > 1 ? String(p) : null }, false)
    },
    [update],
  )
  const setSorting = useCallback(
    (s: SortingState) => {
      const first = s[0]
      update({ ordering: first ? `${first.desc ? '-' : ''}${first.id}` : null })
    },
    [update],
  )
  const setFilter = useCallback(
    (key: string, value: string | null) => {
      update({ [key]: value })
    },
    [update],
  )

  return { page, sorting, ordering, filters, setPage, setSorting, setFilter, update }
}
