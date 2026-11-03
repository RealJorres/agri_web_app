/**
 * The workflow rules of brief §8, with no database access, so that services and record views share
 * one definition.
 *
 * draft -> submitted -> validated -> approved -> locked (on round close)
 * returns: submitted -> draft (validator), validated -> draft (coordinator)
 * reopen: approved or locked -> draft (coordinator, version + 1)
 */
import { Cap } from '../lib/roles.js'
import { canReach, type Scope } from '../lib/scoping.js'
import type { InventoryRecordDoc, RecordStatus, RoundStatus } from '../models/survey.models.js'

export type TransitionName =
  'submit' | 'validate' | 'approve' | 'return_submitted' | 'return_validated' | 'reopen'

export interface Transition {
  sources: readonly RecordStatus[]
  target: RecordStatus
  capability: Cap
  commentRequired: boolean
}

export const TRANSITIONS: Record<TransitionName, Transition> = {
  submit: {
    sources: ['draft'],
    target: 'submitted',
    capability: Cap.SUBMIT,
    commentRequired: false,
  },
  validate: {
    sources: ['submitted'],
    target: 'validated',
    capability: Cap.VALIDATE,
    commentRequired: false,
  },
  approve: {
    sources: ['validated'],
    target: 'approved',
    capability: Cap.APPROVE,
    commentRequired: false,
  },
  return_submitted: {
    sources: ['submitted'],
    target: 'draft',
    capability: Cap.VALIDATE,
    commentRequired: true,
  },
  return_validated: {
    sources: ['validated'],
    target: 'draft',
    capability: Cap.APPROVE,
    commentRequired: true,
  },
  reopen: {
    sources: ['approved', 'locked'],
    target: 'draft',
    capability: Cap.REOPEN,
    commentRequired: true,
  },
}

/** The API has one "return" action. Which rule applies depends on the current status. */
export const RETURN_BY_STATUS: Partial<Record<RecordStatus, TransitionName>> = {
  submitted: 'return_submitted',
  validated: 'return_validated',
}

export type WorkflowRecord = Pick<
  InventoryRecordDoc,
  'status' | 'version' | 'barangayId' | 'municipalityId' | 'programId'
>

export function reaches(scope: Scope, capability: Cap, record: WorkflowRecord): boolean {
  const { barangayId, municipalityId, programId } = record
  return canReach(scope, capability, { barangayId, municipalityId, programId })
}

/** Reopened records (version above 1) may be corrected even after the round has closed. */
export function roundAcceptsChanges(record: WorkflowRecord, roundStatus: RoundStatus): boolean {
  return roundStatus === 'open' || record.version > 1
}

export function canEdit(scope: Scope, record: WorkflowRecord, roundStatus: RoundStatus): boolean {
  if (record.status === 'draft') {
    return roundAcceptsChanges(record, roundStatus) && reaches(scope, Cap.EDIT_RECORDS, record)
  }
  // An MAO validator may correct a record before validating it.
  if (record.status === 'submitted') return reaches(scope, Cap.VALIDATE, record)
  return false
}

/** What the user can do now, for the UI. The services check everything again. */
export function allowedActions(
  scope: Scope,
  record: WorkflowRecord,
  roundStatus: RoundStatus,
): string[] {
  const actions = canEdit(scope, record, roundStatus) ? ['edit'] : []
  for (const [name, transition] of Object.entries(TRANSITIONS)) {
    if (!transition.sources.includes(record.status)) continue
    if (!reaches(scope, transition.capability, record)) continue
    if (name === 'submit' && !roundAcceptsChanges(record, roundStatus)) continue
    actions.push(name.startsWith('return_') ? 'return' : name)
  }
  return actions
}
