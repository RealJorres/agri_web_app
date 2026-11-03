import { ROLE_LABELS, Role } from '../lib/roles.js'
import { Scope, type Grant } from '../lib/scoping.js'
import { UserAssignment, type UserDoc } from '../models/account.models.js'
import { Program } from '../models/catalog.models.js'
import { Barangay, Municipality } from '../models/location.models.js'

/** The user's active grants. Superusers act as system admin everywhere. */
export async function getScope(
  user: Pick<UserDoc, '_id' | 'isActive' | 'isSuperuser'>,
): Promise<Scope> {
  if (!user.isActive) return new Scope(user._id, [])
  const grants: Grant[] = []
  if (user.isSuperuser) {
    grants.push({
      role: Role.SYSTEM_ADMIN,
      municipalityId: null,
      programId: null,
      barangayIds: new Set(),
    })
  }
  const assignments = await UserAssignment.find({ userId: user._id }).lean()
  for (const assignment of assignments) {
    grants.push({
      role: assignment.role,
      municipalityId: assignment.municipalityId,
      programId: assignment.programId,
      barangayIds: new Set(assignment.barangayIds),
    })
  }
  return new Scope(user._id, grants)
}

function byId<T extends { _id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row._id, row]))
}

async function assignmentViews(userId: string) {
  const assignments = await UserAssignment.find({ userId }).sort({ role: 1 }).lean()
  const defined = <T>(values: (T | null)[]): T[] => values.filter((value) => value !== null)
  const [municipalities, programs, barangays] = await Promise.all([
    Municipality.find({ _id: { $in: defined(assignments.map((a) => a.municipalityId)) } }).lean(),
    Program.find({ _id: { $in: defined(assignments.map((a) => a.programId)) } }).lean(),
    Barangay.find({ _id: { $in: assignments.flatMap((a) => a.barangayIds) } }).lean(),
  ])
  const municipalityById = byId(municipalities)
  const programById = byId(programs)
  const barangayById = byId(barangays)

  return assignments.map((assignment) => {
    const municipality = assignment.municipalityId
      ? municipalityById.get(assignment.municipalityId)
      : undefined
    const program = assignment.programId ? programById.get(assignment.programId) : undefined
    return {
      id: assignment._id,
      role: assignment.role,
      role_label: ROLE_LABELS[assignment.role],
      municipality: municipality ? { id: municipality._id, name: municipality.name } : null,
      program: program ? { id: program._id, name: program.name, code: program.code } : null,
      barangays: assignment.barangayIds.flatMap((id) => {
        const barangay = barangayById.get(id)
        return barangay ? [{ id: barangay._id, name: barangay.name }] : []
      }),
    }
  })
}

/** The API shape of the signed-in user. */
export async function meView(user: UserDoc) {
  const [scope, assignments] = await Promise.all([getScope(user), assignmentViews(user._id)])
  return {
    id: user._id,
    email: user.email,
    first_name: user.firstName,
    last_name: user.lastName,
    full_name: `${user.firstName} ${user.lastName}`.trim(),
    is_superuser: user.isSuperuser,
    roles: scope.roles,
    capabilities: scope.capabilities,
    assignments,
  }
}
