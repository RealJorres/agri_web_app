import { dateOnly } from '../lib/dates.js'
import { decimalString } from '../lib/decimal.js'
import { notFound } from '../lib/errors.js'
import { orderRows, type SortFields } from '../lib/ordering.js'
import type { PageRequest } from '../lib/pagination.js'
import { Cap } from '../lib/roles.js'
import { scopeFilter, within, type Scope } from '../lib/scoping.js'
import {
  Commodity,
  type CommodityDoc,
  MaterialSource,
  type MaterialSourceDoc,
  Variety,
  type VarietyDoc,
} from '../models/catalog.models.js'
import {
  COPIED_SCOPE,
  CropStand,
  type CropStandDoc,
  Farm,
  FARM_SCOPE,
  type FarmDoc,
  Harvest,
  type HarvestDoc,
  Planting,
  type PlantingDoc,
} from '../models/farm.models.js'
import { Barangay } from '../models/location.models.js'
import { Farmer, farmerDisplayName, type FarmerDoc } from '../models/registry.models.js'
import { hidePersonal, locationRefs } from './registry.selectors.js'

const MISSING_REF = { id: '', name: '' }

function byOwnId<Row extends { _id: string }>(rows: Row[]): Map<string, Row> {
  return new Map(rows.map((row) => [row._id, row]))
}

function firstOr404<T>(views: T[]): T {
  const [view] = views
  if (view === undefined) throw notFound()
  return view
}

// --- Plantings

async function plantingViews(rows: PlantingDoc[]) {
  const [sources, varieties] = await Promise.all([
    MaterialSource.find({
      _id: { $in: rows.flatMap((row) => (row.sourceId ? [row.sourceId] : [])) },
    }).lean<MaterialSourceDoc[]>(),
    Variety.find({ _id: { $in: rows.flatMap((row) => row.varietyIds) } }).lean<VarietyDoc[]>(),
  ])
  const sourceById = byOwnId(sources)
  const varietyById = byOwnId(varieties)
  const views = rows.map((row) => ({
    id: row._id,
    crop_stand: row.cropStandId,
    year_planted: row.yearPlanted,
    source: row.sourceId ? (sourceById.get(row.sourceId)?.code ?? null) : null,
    qty_planted: row.qtyPlanted,
    notes: row.notes,
    varieties: row.varietyIds.flatMap((id) => varietyById.get(id)?.code ?? []),
  }))
  return orderRows(views, undefined, { year: (view) => view.year_planted }, ['year'])
}

async function plantingById(scope: Scope, id: string): Promise<PlantingDoc> {
  const visible = scopeFilter(scope, Cap.VIEW_RECORDS, COPIED_SCOPE)
  const row = await Planting.findOne(within(visible, { _id: id })).lean<PlantingDoc>()
  if (!row) throw notFound()
  return row
}

export async function getPlanting(scope: Scope, id: string) {
  return firstOr404(await plantingViews([await plantingById(scope, id)]))
}

export async function listPlantingsOfStand(scope: Scope, standId: string) {
  await requireCropStand(scope, standId)
  const rows = await Planting.find({ cropStandId: standId }).lean<PlantingDoc[]>()
  return plantingViews(rows)
}

// --- Crop stands

async function standViews(rows: CropStandDoc[]) {
  const [commodities, plantings] = await Promise.all([
    Commodity.find({ _id: { $in: rows.map((row) => row.commodityId) } }).lean<CommodityDoc[]>(),
    Planting.find({ cropStandId: { $in: rows.map((row) => row._id) } }).lean<PlantingDoc[]>(),
  ])
  const commodityById = byOwnId(commodities)
  const plantingRows = await plantingViews(plantings)
  return rows.map((row) => {
    const commodity = commodityById.get(row.commodityId)
    return {
      id: row._id,
      farm: row.farmId,
      commodity: {
        id: row.commodityId,
        name: commodity?.name ?? '',
        code: commodity?.code ?? '',
      },
      spacing_m: decimalString(row.spacingM, 2),
      attributes: row.attributes,
      plantings: plantingRows.filter((planting) => planting.crop_stand === row._id),
    }
  })
}
type StandView = Awaited<ReturnType<typeof standViews>>[number]

const STAND_ORDER: SortFields<StandView> = {
  id: (row) => row.id,
  commodity: (row) => row.commodity.name,
  spacing_m: (row) => (row.spacing_m === null ? null : Number(row.spacing_m)),
}

export async function listCropStands(scope: Scope, page: PageRequest, ordering: unknown) {
  const visible = scopeFilter(scope, Cap.VIEW_RECORDS, COPIED_SCOPE)
  const rows = await CropStand.find(visible).lean<CropStandDoc[]>()
  const commodities = await Commodity.find().select('name').lean<CommodityDoc[]>()
  const commodityName = new Map(commodities.map((row) => [row._id, row.name]))
  const ordered = orderRows(
    rows,
    ordering,
    {
      id: (row) => row._id,
      commodity: (row) => commodityName.get(row.commodityId) ?? null,
      spacing_m: (row) => (row.spacingM ? Number(row.spacingM.toString()) : null),
    },
    ['commodity'],
  )
  return {
    count: ordered.length,
    results: await standViews(ordered.slice(page.skip, page.skip + page.pageSize)),
  }
}

async function standById(scope: Scope, id: string): Promise<CropStandDoc> {
  const visible = scopeFilter(scope, Cap.VIEW_RECORDS, COPIED_SCOPE)
  const row = await CropStand.findOne(within(visible, { _id: id })).lean<CropStandDoc>()
  if (!row) throw notFound()
  return row
}

export async function requireCropStand(scope: Scope, id: string): Promise<void> {
  await standById(scope, id)
}

export async function getCropStand(scope: Scope, id: string) {
  return firstOr404(await standViews([await standById(scope, id)]))
}

// --- Farms

async function farmViews(scope: Scope, rows: FarmDoc[]) {
  const [farmers, refs, stands] = await Promise.all([
    Farmer.find({ _id: { $in: rows.map((row) => row.farmerId) } }).lean<FarmerDoc[]>(),
    locationRefs(rows.map((row) => row.barangayId)),
    CropStand.find({ farmId: { $in: rows.map((row) => row._id) } }).lean<CropStandDoc[]>(),
  ])
  const farmerById = byOwnId(farmers)
  const standRows = orderRows(await standViews(stands), undefined, STAND_ORDER, ['commodity'])
  return rows.map((row) => {
    const farmer = farmerById.get(row.farmerId)
    const location = refs.get(row.barangayId)
    const [lon, lat] = row.location?.coordinates ?? []
    const view = {
      id: row._id,
      farmer: row.farmerId,
      farmer_name: farmer ? farmerDisplayName(farmer) : '',
      barangay: location?.barangay ?? MISSING_REF,
      municipality: location?.municipality ?? MISSING_REF,
      sitio: row.sitio,
      location: lon !== undefined && lat !== undefined ? { lon, lat } : null,
      declared_area_ha: decimalString(row.declaredAreaHa, 4),
      tenure: row.tenure,
      location_raw: row.locationRaw,
      crop_stands: standRows.filter((stand) => stand.farm === row._id),
    }
    return hidePersonal(scope, view, ['sitio', 'location', 'location_raw', 'farmer_name'])
  })
}

export interface FarmFilters {
  farmer?: string | undefined
  barangay?: string | undefined
  municipality?: string | undefined
  tenure?: string | undefined
}

export async function listFarms(
  scope: Scope,
  filters: FarmFilters,
  page: PageRequest,
  ordering: unknown,
) {
  const conditions: Record<string, unknown>[] = []
  if (filters.farmer) conditions.push({ farmerId: filters.farmer })
  if (filters.barangay) conditions.push({ barangayId: filters.barangay })
  if (filters.municipality) conditions.push({ municipalityId: filters.municipality })
  if (filters.tenure) conditions.push({ tenure: filters.tenure })
  const visible = scopeFilter(scope, Cap.VIEW_RECORDS, FARM_SCOPE)
  const rows = await Farm.find(within(visible, ...conditions)).lean<FarmDoc[]>()
  const barangays = await Barangay.find().select('name').lean()
  const barangayName = new Map(barangays.map((row) => [row._id, row.name]))
  const ordered = orderRows(
    rows,
    ordering,
    {
      id: (row) => row._id,
      barangay: (row) => barangayName.get(row.barangayId) ?? null,
      sitio: (row) => row.sitio,
      tenure: (row) => row.tenure,
      declared_area_ha: (row) =>
        row.declaredAreaHa ? Number(row.declaredAreaHa.toString()) : null,
    },
    ['barangay'],
  )
  return {
    count: ordered.length,
    results: await farmViews(scope, ordered.slice(page.skip, page.skip + page.pageSize)),
  }
}

async function farmById(scope: Scope, id: string): Promise<FarmDoc> {
  const visible = scopeFilter(scope, Cap.VIEW_RECORDS, FARM_SCOPE)
  const row = await Farm.findOne(within(visible, { _id: id })).lean<FarmDoc>()
  if (!row) throw notFound()
  return row
}

export async function requireFarm(scope: Scope, id: string): Promise<void> {
  await farmById(scope, id)
}

export async function getFarm(scope: Scope, id: string) {
  return firstOr404(await farmViews(scope, [await farmById(scope, id)]))
}

export async function listStandsOfFarm(scope: Scope, farmId: string) {
  await requireFarm(scope, farmId)
  const rows = await CropStand.find({ farmId }).lean<CropStandDoc[]>()
  return orderRows(await standViews(rows), undefined, STAND_ORDER, ['commodity'])
}

/**
 * Located farms in scope, and how many in scope have no location yet. Coordinates are personal data
 * and carry no names: a point links to the farmer's page, where access is checked again.
 */
export async function farmPoints(
  scope: Scope,
  { municipality }: { municipality?: string | undefined },
) {
  const visible = scopeFilter(scope, Cap.VIEW_PERSONAL_DATA, FARM_SCOPE)
  const place = municipality ? { municipalityId: municipality } : {}
  const farms = await Farm.find(within(visible, place)).lean<FarmDoc[]>()
  const located = farms.filter((farm) => farm.location !== null)
  const refs = await locationRefs(located.map((farm) => farm.barangayId))
  const results = located.map((farm) => ({
    id: farm._id,
    farmer: farm.farmerId,
    lon: farm.location?.coordinates[0],
    lat: farm.location?.coordinates[1],
    barangay: refs.get(farm.barangayId)?.barangay.name ?? '',
    municipality: refs.get(farm.barangayId)?.municipality.name ?? '',
  }))
  return { results, total_farms: farms.length, located: results.length }
}

// --- Harvests

function harvestView(row: HarvestDoc) {
  return {
    id: row._id,
    crop_stand: row.cropStandId,
    harvest_date: dateOnly(row.harvestDate),
    date_estimated: row.dateEstimated,
    quantity: decimalString(row.quantity, 3),
    unit: row.unit,
    product_form: row.productForm,
    price_per_unit: decimalString(row.pricePerUnit, 2),
    buyer: row.buyer,
    raw_text: row.rawText,
    created_at: row.createdAt.toISOString(),
  }
}

export async function getHarvest(scope: Scope, id: string) {
  const visible = scopeFilter(scope, Cap.VIEW_RECORDS, COPIED_SCOPE)
  const row = await Harvest.findOne(within(visible, { _id: id })).lean<HarvestDoc>()
  if (!row) throw notFound()
  return harvestView(row)
}

export async function listHarvestsOfStand(scope: Scope, standId: string) {
  await requireCropStand(scope, standId)
  const rows = await Harvest.find({ cropStandId: standId }).lean<HarvestDoc[]>()
  // Newest first, with undated rows ahead of them, as before.
  const ordered = orderRows(
    rows,
    undefined,
    {
      date: (row) => row.harvestDate?.getTime() ?? null,
      created: (row) => row.createdAt.getTime(),
    },
    ['-date', '-created'],
  )
  return ordered.map(harvestView)
}
