/**
 * Server-side row scoping. Every record-level query goes through scopeFilter.
 *
 * A row is visible when ANY of the user's grants carrying the capability covers it:
 * - location: grant barangays (field encoders), else grant municipality, else unrestricted;
 * - program: the grant's program, applied only when the collection has a program field.
 * Out-of-scope rows simply do not exist for the user, so detail requests answer 404.
 */
import { DomainError } from './errors.js'
import { ROLE_CAPABILITIES, type Cap, type Role } from './roles.js'

export interface Grant {
  role: Role
  /** null means unrestricted on that dimension. */
  municipalityId: string | null
  programId: string | null
  barangayIds: ReadonlySet<string>
}

export class Scope {
  constructor(
    readonly userId: string | null,
    readonly grants: readonly Grant[],
  ) {}

  get roles(): Role[] {
    return [...new Set(this.grants.map((grant) => grant.role))].sort()
  }

  get capabilities(): Cap[] {
    const capabilities = new Set<Cap>()
    for (const grant of this.grants) {
      for (const capability of ROLE_CAPABILITIES[grant.role]) capabilities.add(capability)
    }
    return [...capabilities].sort()
  }

  can(capability: Cap): boolean {
    return this.grants.some((grant) => ROLE_CAPABILITIES[grant.role].has(capability))
  }

  grantsWith(capability: Cap): Grant[] {
    return this.grants.filter((grant) => ROLE_CAPABILITIES[grant.role].has(capability))
  }
}

export const EMPTY_SCOPE = new Scope(null, [])

/** The fields on a collection that hold its copied location and program keys (ADR-0019). */
export interface ScopePaths {
  barangay?: string
  municipality?: string
  program?: string
}

/** For documents that copy all three keys, such as farms and everything under them. */
export const COPIED_SCOPE_PATHS: ScopePaths = {
  barangay: 'barangayId',
  municipality: 'municipalityId',
  program: 'programId',
}

type Filter = Record<string, unknown>

/** Matches no document. Used when no grant applies, so a mistake can never mean "everything". */
const NOTHING: Filter = { _id: { $in: [] } }

export function scopeFilter(scope: Scope, capability: Cap, paths: ScopePaths): Filter {
  const alternatives: Filter[] = []
  for (const grant of scope.grantsWith(capability)) {
    const clause: Filter = {}
    if (grant.barangayIds.size > 0 && paths.barangay) {
      clause[paths.barangay] = { $in: [...grant.barangayIds] }
    } else if (grant.municipalityId !== null) {
      if (!paths.municipality) continue // location-limited grants cannot see location-less data
      clause[paths.municipality] = grant.municipalityId
    } else if (grant.barangayIds.size > 0) {
      continue // barangay-limited grant, collection has no barangay field: deny
    }
    if (grant.programId !== null && paths.program) clause[paths.program] = grant.programId
    alternatives.push(clause)
  }
  if (alternatives.length === 0) return NOTHING
  if (alternatives.some((clause) => Object.keys(clause).length === 0)) return {}
  return { $or: alternatives }
}

export interface ReachTarget {
  barangayId?: string | null
  municipalityId?: string | null
  programId?: string | null
}

/** The in-memory twin of scopeFilter, for writes: may the user act on this target? */
export function canReach(scope: Scope, capability: Cap, target: ReachTarget): boolean {
  const { barangayId, municipalityId, programId } = target
  return scope.grantsWith(capability).some((grant) => {
    if (grant.programId !== null && programId != null && grant.programId !== programId) {
      return false
    }
    if (grant.barangayIds.size > 0 && barangayId != null) {
      return grant.barangayIds.has(barangayId)
    }
    if (grant.municipalityId !== null) return grant.municipalityId === municipalityId
    return grant.barangayIds.size === 0
  })
}

/** Raises a 403 naming the field when the target of a write is outside the user's scope. */
export function requireReach(
  scope: Scope,
  capability: Cap,
  target: ReachTarget,
  field: string,
): void {
  if (!canReach(scope, capability, target)) {
    throw new DomainError(
      'out_of_scope',
      'This is outside your assignment.',
      { [field]: ['Outside your assigned area or program.'] },
      403,
    )
  }
}
