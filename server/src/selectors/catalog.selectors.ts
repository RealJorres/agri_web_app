import { decimalString } from '../lib/decimal.js'
import { notFound } from '../lib/errors.js'
import { orderRows, type SortFields } from '../lib/ordering.js'
import { normalizeCode } from '../lib/text.js'
import {
  Commodity,
  GrowthStage,
  MaterialSource,
  Program,
  Unit,
  Variety,
  type CommodityDoc,
  type GrowthStageDoc,
  type MaterialSourceDoc,
  type ProgramDoc,
  type UnitDoc,
  type VarietyDoc,
} from '../models/catalog.models.js'

export class AliasConflictError extends Error {}

interface Aliased {
  code: string
  aliases: readonly string[]
  name?: string
  label?: string
}

/**
 * Exact lookup of catalog rows by normalized code, name, label or alias. Never fuzzy: an unknown
 * value returns undefined and goes to the import review list (brief §6, "Never guess").
 */
export class AliasIndex<Row extends Aliased> {
  private readonly byKey = new Map<string, Row>()

  constructor(rows: Iterable<Row>) {
    for (const row of rows) {
      const keys = [row.code, ...row.aliases, row.name ?? row.label ?? '']
      for (const key of keys.map(normalizeCode).filter(Boolean)) {
        const existing = this.byKey.get(key)
        if (existing !== undefined && existing !== row) {
          throw new AliasConflictError(`'${key}' maps to both ${existing.code} and ${row.code}`)
        }
        this.byKey.set(key, row)
      }
    }
  }

  resolve(raw: string | null | undefined): Row | undefined {
    return raw ? this.byKey.get(normalizeCode(raw)) : undefined
  }

  get size(): number {
    return this.byKey.size
  }
}

export async function stageIndex(commodityId: string): Promise<AliasIndex<GrowthStageDoc>> {
  return new AliasIndex(await GrowthStage.find({ commodityId }).lean<GrowthStageDoc[]>())
}

export async function varietyIndex(commodityId: string): Promise<AliasIndex<VarietyDoc>> {
  return new AliasIndex(await Variety.find({ commodityId }).lean<VarietyDoc[]>())
}

export async function sourceIndex(): Promise<AliasIndex<MaterialSourceDoc>> {
  return new AliasIndex(await MaterialSource.find().lean<MaterialSourceDoc[]>())
}

/**
 * Plants per hectare: from a stand's spacing override (square planting), otherwise the commodity's
 * configured density (ADR-0004).
 */
export function plantsPerHa(
  commodity: Pick<CommodityDoc, 'plantsPerHa'>,
  spacingM?: number | null,
): number | null {
  if (spacingM) return 10_000 / spacingM ** 2
  return commodity.plantsPerHa ? commodity.plantsPerHa : null
}

// --- API views, in the shape of frontend/openapi.json.

function programView(row: ProgramDoc) {
  return { id: row._id, code: row.code, name: row.name }
}
type ProgramView = ReturnType<typeof programView>

const PROGRAM_ORDER: SortFields<ProgramView> = {
  id: (row) => row.id,
  code: (row) => row.code,
  name: (row) => row.name,
}

export async function listPrograms(ordering?: unknown): Promise<ProgramView[]> {
  const rows = await Program.find().lean<ProgramDoc[]>()
  return orderRows(rows.map(programView), ordering, PROGRAM_ORDER, ['code'])
}

export async function getProgram(id: string): Promise<ProgramView> {
  const row = await Program.findOne({ _id: id }).lean<ProgramDoc>()
  if (!row) throw notFound()
  return programView(row)
}

function stageView(row: GrowthStageDoc) {
  return {
    id: row._id,
    code: row.code,
    label: row.label,
    sort_order: row.sortOrder,
    is_bearing: row.isBearing,
  }
}

function commodityView(row: CommodityDoc, program: ProgramDoc, stages: GrowthStageDoc[]) {
  return {
    id: row._id,
    code: row.code,
    name: row.name,
    program: programView(program),
    measure_type: row.measureType,
    spacing_m: decimalString(row.spacingM, 2),
    plants_per_ha: row.plantsPerHa,
    attributes_schema: row.attributesSchema,
    outlier_multiplier: decimalString(row.outlierMultiplier, 2),
    stages: stages.map(stageView),
  }
}
type CommodityView = ReturnType<typeof commodityView>

const COMMODITY_ORDER: SortFields<CommodityView> = {
  id: (row) => row.id,
  code: (row) => row.code,
  name: (row) => row.name,
  program: (row) => row.program.code,
  measure_type: (row) => row.measure_type,
  spacing_m: (row) => (row.spacing_m === null ? null : Number(row.spacing_m)),
  plants_per_ha: (row) => row.plants_per_ha,
  outlier_multiplier: (row) => Number(row.outlier_multiplier),
}

async function commodityViews(rows: CommodityDoc[]): Promise<CommodityView[]> {
  const [programs, stages] = await Promise.all([
    Program.find({ _id: { $in: rows.map((row) => row.programId) } }).lean<ProgramDoc[]>(),
    GrowthStage.find({ commodityId: { $in: rows.map((row) => row._id) } })
      .sort({ sortOrder: 1 })
      .lean<GrowthStageDoc[]>(),
  ])
  const programById = new Map(programs.map((program) => [program._id, program]))
  return rows.flatMap((row) => {
    const program = programById.get(row.programId)
    // A commodity cannot lose its program through a service, so this only skips broken data.
    if (!program) return []
    const own = stages.filter((stage) => stage.commodityId === row._id)
    return [commodityView(row, program, own)]
  })
}

export async function listCommodities(
  filters: { program?: string | undefined },
  ordering?: unknown,
): Promise<CommodityView[]> {
  const query = filters.program ? { programId: filters.program } : {}
  const views = await commodityViews(await Commodity.find(query).lean<CommodityDoc[]>())
  return orderRows(views, ordering, COMMODITY_ORDER, ['name'])
}

export async function getCommodity(id: string): Promise<CommodityView> {
  const row = await Commodity.findOne({ _id: id }).lean<CommodityDoc>()
  const [view] = row ? await commodityViews([row]) : []
  if (!view) throw notFound()
  return view
}

export async function listCommodityStages(
  id: string,
  filters: { program?: string | undefined },
): Promise<ReturnType<typeof stageView>[]> {
  const query = { _id: id, ...(filters.program ? { programId: filters.program } : {}) }
  if (!(await Commodity.exists(query))) throw notFound()
  const stages = await GrowthStage.find({ commodityId: id })
    .sort({ sortOrder: 1 })
    .lean<GrowthStageDoc[]>()
  return stages.map(stageView)
}

function varietyView(row: VarietyDoc) {
  return { id: row._id, commodity: row.commodityId, code: row.code, name: row.name }
}
type VarietyView = ReturnType<typeof varietyView>

const VARIETY_ORDER: SortFields<VarietyView> = {
  id: (row) => row.id,
  commodity: (row) => row.commodity,
  code: (row) => row.code,
  name: (row) => row.name,
}

export async function listVarieties(
  filters: { commodity?: string | undefined },
  ordering?: unknown,
): Promise<VarietyView[]> {
  const query = filters.commodity ? { commodityId: filters.commodity } : {}
  const rows = await Variety.find(query).lean<VarietyDoc[]>()
  return orderRows(rows.map(varietyView), ordering, VARIETY_ORDER, ['code'])
}

export async function getVariety(id: string): Promise<VarietyView> {
  const row = await Variety.findOne({ _id: id }).lean<VarietyDoc>()
  if (!row) throw notFound()
  return varietyView(row)
}

function sourceView(row: MaterialSourceDoc) {
  return { id: row._id, code: row.code, name: row.name }
}
type SourceView = ReturnType<typeof sourceView>

const SOURCE_ORDER: SortFields<SourceView> = {
  id: (row) => row.id,
  code: (row) => row.code,
  name: (row) => row.name,
}

export async function listMaterialSources(ordering?: unknown): Promise<SourceView[]> {
  const rows = await MaterialSource.find().lean<MaterialSourceDoc[]>()
  return orderRows(rows.map(sourceView), ordering, SOURCE_ORDER, ['code'])
}

export async function getMaterialSource(id: string): Promise<SourceView> {
  const row = await MaterialSource.findOne({ _id: id }).lean<MaterialSourceDoc>()
  if (!row) throw notFound()
  return sourceView(row)
}

function unitView(row: UnitDoc) {
  return {
    id: row._id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    to_base: decimalString(row.toBase, 6),
  }
}
type UnitView = ReturnType<typeof unitView>

const UNIT_ORDER: SortFields<UnitView> = {
  id: (row) => row.id,
  code: (row) => row.code,
  name: (row) => row.name,
  kind: (row) => row.kind,
  to_base: (row) => (row.to_base === null ? null : Number(row.to_base)),
}

export async function listUnits(ordering?: unknown): Promise<UnitView[]> {
  const rows = await Unit.find().lean<UnitDoc[]>()
  return orderRows(rows.map(unitView), ordering, UNIT_ORDER, ['kind', 'code'])
}

export async function getUnit(id: string): Promise<UnitView> {
  const row = await Unit.findOne({ _id: id }).lean<UnitDoc>()
  if (!row) throw notFound()
  return unitView(row)
}
