import type { Request } from 'express'

import { DomainError } from './errors.js'

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

export interface PageRequest {
  page: number
  pageSize: number
  skip: number
}

export interface Page<T> {
  count: number
  next: string | null
  previous: string | null
  results: T[]
}

function positiveInteger(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export function pageRequest(req: Request): PageRequest {
  const rawPage = req.query.page
  const page = rawPage === undefined ? 1 : positiveInteger(rawPage)
  if (page === null) throw new DomainError('not_found', 'Invalid page.', {}, 404)
  const pageSize = Math.min(
    positiveInteger(req.query.page_size) ?? DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  )
  return { page, pageSize, skip: (page - 1) * pageSize }
}

function pageUrl(req: Request, page: number): string {
  const url = new URL(req.originalUrl, `${req.protocol}://${req.get('host') ?? 'localhost'}`)
  url.searchParams.set('page', String(page))
  return url.toString()
}

/** The list envelope: {count, next, previous, results}. A page past the end is a 404. */
export function pageOf<T>(
  req: Request,
  request: PageRequest,
  count: number,
  results: T[],
): Page<T> {
  const { page, pageSize } = request
  const lastPage = Math.max(1, Math.ceil(count / pageSize))
  if (page > lastPage) throw new DomainError('not_found', 'Invalid page.', {}, 404)
  return {
    count,
    next: page < lastPage ? pageUrl(req, page + 1) : null,
    previous: page > 1 ? pageUrl(req, page - 1) : null,
    results,
  }
}
