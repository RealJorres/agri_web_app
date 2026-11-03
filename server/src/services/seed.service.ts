import { seedCatalog } from './catalog.service.js'
import { findPsgcFile, loadPsgc, PROVINCE, seedMunicipalities } from './location.service.js'

function counts(bucket: Record<string, number>): string {
  const parts = Object.entries(bucket).map(([model, count]) => `${model} ${String(count)}`)
  return parts.length > 0 ? parts.join(', ') : 'none'
}

/** Seeds municipalities and the catalog, then PSGC codes if the file is present. Returns a report. */
export async function runSeed(referenceDir: string): Promise<string[]> {
  const lines = [`Municipalities: ${String(await seedMunicipalities())} created`]
  const report = await seedCatalog()
  lines.push(`Catalog: created ${counts(report.created)}; updated ${counts(report.updated)}`)
  const file = await findPsgcFile(referenceDir)
  if (file === undefined) {
    lines.push(
      'No PSGC file in data/reference/: municipality and barangay codes stay empty (ADR-0005).',
    )
    return lines
  }
  const result = await loadPsgc(file, { province: PROVINCE })
  lines.push(
    `PSGC: ${String(result.municipalitiesCoded.length)} municipalities coded, ` +
      `${String(result.barangaysVerified)} barangays verified, ` +
      `${String(result.barangaysCreated)} created`,
  )
  return lines
}
