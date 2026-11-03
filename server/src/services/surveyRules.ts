/**
 * Validation rules for inventory records (brief §8). Errors block submission, and warnings are kept
 * in the record's flags. "Farm barangay required" has no rule here, because the models require it
 * on the farm and on the keys copied to the record.
 */
import { Decimal } from 'decimal.js'
import type { ClientSession, Types } from 'mongoose'

import { decimalString } from '../lib/decimal.js'
import type { CommodityDoc, MeasureType } from '../models/catalog.models.js'
import { farmerDisplayName, type FarmerDoc } from '../models/registry.models.js'
import {
  InventoryRecord,
  type InventoryRecordDoc,
  type StageCount,
} from '../models/survey.models.js'
import { DUPLICATE_WARN_SIMILARITY, findDuplicateFarmers } from '../selectors/registry.selectors.js'

const MIN_OUTLIER_SAMPLE = 5

export interface Issue {
  level: 'error' | 'warning'
  code: string
  message: string
  field: string
  data: Record<string, unknown>
}

function areaOf(value: Types.Decimal128 | null): Decimal {
  return new Decimal(value ? value.toString() : 0)
}

/** A record's measured quantity: trees for tree crops, hectares for area crops. */
export function standTotal(counts: readonly StageCount[], measureType: MeasureType): Decimal {
  return counts.reduce(
    (total, row) =>
      total.plus(measureType === 'area' ? areaOf(row.areaHa) : new Decimal(row.count ?? 0)),
    new Decimal(0),
  )
}

export function checkNotEmpty(
  counts: readonly StageCount[],
  measureType: MeasureType,
  remarks: string,
): Issue[] {
  if (standTotal(counts, measureType).greaterThan(0) || remarks.trim()) return []
  return [
    {
      level: 'error',
      code: 'empty_record',
      message: 'Enter at least one stage count, or explain in the remarks why there is none.',
      field: 'counts',
      data: {},
    },
  ]
}

function median(values: Decimal[]): Decimal {
  const sorted = [...values].sort((a, b) => a.comparedTo(b))
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle] as Decimal
  if (sorted.length % 2 === 1) return upper
  return upper.plus(sorted[middle - 1] as Decimal).dividedBy(2)
}

function withCommas(value: Decimal): string {
  const [whole = '', fraction] = value.toFixed().split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
  return fraction === undefined ? grouped : `${grouped}.${fraction}`
}

/** Warns when this stand exceeds the outlier multiplier times the municipal median of the round. */
export async function checkOutlier(
  record: InventoryRecordDoc,
  commodity: CommodityDoc,
  session?: ClientSession,
): Promise<Issue[]> {
  const peers = await InventoryRecord.find({
    surveyRoundId: record.surveyRoundId,
    municipalityId: record.municipalityId,
    _id: { $ne: record._id },
    status: { $ne: 'draft' },
  })
    .session(session ?? null)
    .select('stageCounts')
    .lean<Pick<InventoryRecordDoc, 'stageCounts'>[]>()
  if (peers.length < MIN_OUTLIER_SAMPLE) return []
  const middle = median(peers.map((peer) => standTotal(peer.stageCounts, commodity.measureType)))
  const total = standTotal(record.stageCounts, commodity.measureType)
  const multiplier = new Decimal(commodity.outlierMultiplier.toString())
  if (middle.lessThanOrEqualTo(0) || total.lessThanOrEqualTo(multiplier.times(middle))) return []
  return [
    {
      level: 'warning',
      code: 'outlier',
      message:
        `Total ${withCommas(total)} is more than ${decimalString(commodity.outlierMultiplier, 2) ?? ''}x ` +
        `the municipal median (${withCommas(middle)}). Please double-check.`,
      field: 'counts',
      data: { total: total.toFixed(), median: middle.toFixed(), sample: peers.length },
    },
  ]
}

/** Warns on a likely duplicate in the same municipality or with the same RSBSA. Ids, no names. */
export async function checkDuplicateFarmer(farmer: FarmerDoc): Promise<Issue[]> {
  const candidates = await findDuplicateFarmers(
    {},
    {
      name: farmerDisplayName(farmer),
      municipalityId: farmer.municipalityId,
      rsbsaNo: farmer.rsbsaNo ?? undefined,
      excludeId: farmer._id,
      threshold: DUPLICATE_WARN_SIMILARITY,
    },
  )
  if (candidates.length === 0) return []
  return [
    {
      level: 'warning',
      code: 'possible_duplicate_farmer',
      message:
        'This farmer may already be registered. Review and merge if they are the same person.',
      field: 'farmer',
      data: {
        candidates: candidates.map(({ farmer: match, similarity, reason }) => ({
          id: match._id,
          similarity,
          reason,
        })),
      },
    },
  ]
}

export async function evaluate(
  record: InventoryRecordDoc,
  commodity: CommodityDoc,
  farmer: FarmerDoc | null,
  session?: ClientSession,
): Promise<Issue[]> {
  return [
    ...checkNotEmpty(record.stageCounts, commodity.measureType, record.remarks),
    ...(await checkOutlier(record, commodity, session)),
    ...(farmer ? await checkDuplicateFarmer(farmer) : []),
  ]
}
