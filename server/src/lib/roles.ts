/**
 * Roles and the capabilities each one grants (brief §7). Scoping comes from the assignment;
 * capabilities say what the role may do inside that scope. Code checks capabilities, never roles.
 */
export const Role = {
  SYSTEM_ADMIN: 'system_admin',
  PROVINCIAL_HEAD: 'provincial_head',
  PROGRAM_COORDINATOR: 'program_coordinator',
  PROVINCIAL_ENCODER: 'provincial_encoder',
  MAO_VALIDATOR: 'mao_validator',
  FIELD_ENCODER: 'field_encoder',
  VIEWER: 'viewer',
} as const
export type Role = (typeof Role)[keyof typeof Role]
export const ALL_ROLES = Object.values(Role)

export const ROLE_LABELS: Record<Role, string> = {
  system_admin: 'System admin',
  provincial_head: 'Provincial head',
  program_coordinator: 'Program coordinator',
  provincial_encoder: 'Provincial encoder',
  mao_validator: 'MAO validator',
  field_encoder: 'Field encoder',
  viewer: 'Viewer',
}

export const Cap = {
  VIEW_AGGREGATES: 'view_aggregates',
  VIEW_RECORDS: 'view_records', // record-level endpoints (ADR-0010)
  VIEW_PERSONAL_DATA: 'view_personal_data',
  EDIT_RECORDS: 'edit_records', // create and edit farmers, farms, drafts
  SUBMIT: 'submit',
  VALIDATE: 'validate',
  APPROVE: 'approve',
  REOPEN: 'reopen',
  MANAGE_ROUNDS: 'manage_rounds',
  RUN_IMPORTS: 'run_imports',
  MERGE_FARMERS: 'merge_farmers',
  EXPORT_PERSONAL_DATA: 'export_personal_data',
  SIGN_REPORTS: 'sign_reports', // final sign-off on official reports
  ADMIN: 'admin',
} as const
export type Cap = (typeof Cap)[keyof typeof Cap]

const READ: Cap[] = [Cap.VIEW_AGGREGATES, Cap.VIEW_RECORDS, Cap.VIEW_PERSONAL_DATA]

export const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Cap>> = {
  system_admin: new Set(Object.values(Cap)),
  provincial_head: new Set([...READ, Cap.EXPORT_PERSONAL_DATA, Cap.SIGN_REPORTS]),
  program_coordinator: new Set([
    ...READ,
    Cap.APPROVE,
    Cap.REOPEN,
    Cap.MANAGE_ROUNDS,
    Cap.MERGE_FARMERS,
    Cap.EXPORT_PERSONAL_DATA,
  ]),
  provincial_encoder: new Set([...READ, Cap.EDIT_RECORDS, Cap.SUBMIT, Cap.RUN_IMPORTS]),
  mao_validator: new Set([...READ, Cap.EDIT_RECORDS, Cap.VALIDATE]),
  field_encoder: new Set([...READ, Cap.EDIT_RECORDS, Cap.SUBMIT]),
  viewer: new Set([Cap.VIEW_AGGREGATES]),
}

/** Roles whose assignment may be narrowed to specific barangays. */
export const BARANGAY_SCOPED_ROLES: ReadonlySet<Role> = new Set([Role.FIELD_ENCODER])
