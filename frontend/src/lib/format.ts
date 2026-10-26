const numberFormat = new Intl.NumberFormat('en-PH')
const dateFormat = new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium' })
const dateTimeFormat = new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' })

export function formatNumber(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  return numberFormat.format(Number(value))
}

export function formatHectares(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  return `${Number(value).toFixed(2)} ha`
}

export function formatDate(value: string | null | undefined): string {
  return value ? dateFormat.format(new Date(value)) : '—'
}

export function formatDateTime(value: string | null | undefined): string {
  return value ? dateTimeFormat.format(new Date(value)) : '—'
}

export function formatSigned(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return value > 0 ? `+${formatNumber(value)}` : formatNumber(value)
}

export const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  validated: 'Validated',
  approved: 'Approved',
  locked: 'Locked',
  open: 'Open',
  closed: 'Closed',
  active: 'Active',
  inactive: 'Inactive',
  needs_review: 'Needs review',
  uploaded: 'Uploaded',
  validating: 'Validating',
  ready: 'Ready to commit',
  committing: 'Committing',
  committed: 'Committed',
  failed: 'Failed',
}

export const ROLE_LABELS: Record<string, string> = {
  system_admin: 'System admin',
  provincial_head: 'Provincial head',
  program_coordinator: 'Program coordinator',
  provincial_encoder: 'Provincial encoder',
  mao_validator: 'MAO validator',
  field_encoder: 'Field encoder',
  viewer: 'Viewer',
}
