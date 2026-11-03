/**
 * Shared permission-matrix definitions (brief §7). Every record-level endpoint registers an Endpoint.
 * One actor is built per role, with the location-limited roles assigned to Gasan, and each role is
 * checked against a Gasan object ("own") and a Boac object ("other").
 */
import { Role } from '../../src/lib/roles.js'
import type { UserDoc } from '../../src/models/account.models.js'
import type { BarangayDoc, MunicipalityDoc } from '../../src/models/location.models.js'
import { userWithRole } from './factories.js'

export const OWN = 'own'
export const OTHER = 'other'
export type Relation = typeof OWN | typeof OTHER

/** Expected status for reading one personal or record-level object. */
export const READ_DETAIL: Record<Role, Record<Relation, number>> = {
  system_admin: { own: 200, other: 200 },
  provincial_head: { own: 200, other: 200 },
  program_coordinator: { own: 200, other: 200 },
  provincial_encoder: { own: 200, other: 200 },
  mao_validator: { own: 200, other: 404 },
  field_encoder: { own: 200, other: 404 },
  viewer: { own: 403, other: 403 }, // ADR-0010: aggregates only
}

export interface Endpoint {
  name: string
  /** The route in the route table, as "METHOD /path". */
  routes: string[]
  listUrl: string | null
  detailUrl: ((id: string) => string) | null
  /** Creates an object located in the given barangay and returns its id. */
  make: (barangay: BarangayDoc) => Promise<string>
  readDetail?: Record<Role, Record<Relation, number>>
}

export function expectedStatus(endpoint: Endpoint, role: Role, relation: Relation): number {
  return (endpoint.readDetail ?? READ_DETAIL)[role][relation]
}

/** One user per role; location-limited roles are assigned to the home municipality. */
export function makeActor(
  role: Role,
  home: MunicipalityDoc,
  homeBarangay: BarangayDoc,
): Promise<UserDoc> {
  if (role === Role.SYSTEM_ADMIN) return userWithRole(role, {}, { isSuperuser: true })
  if (role === Role.MAO_VALIDATOR) return userWithRole(role, { municipalityId: home._id })
  if (role === Role.FIELD_ENCODER) {
    return userWithRole(role, { municipalityId: home._id, barangayIds: [homeBarangay._id] })
  }
  return userWithRole(role)
}
