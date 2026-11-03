/** Exact decimals: Decimal128 where stored, decimal.js in between, fixed-place strings in the API. */
import { Decimal } from 'decimal.js'
import { Types } from 'mongoose'

/** Decimal with half-up rounding, the rule for every figure the system shows (ADR-0019). */
export const HalfUp = Decimal.clone({ rounding: Decimal.ROUND_HALF_UP })

export function toDecimal128(value: Decimal.Value): Types.Decimal128 {
  return Types.Decimal128.fromString(new HalfUp(value).toString())
}

/** '4' with 2 places -> '4.00'. Null stays null, because a missing value is not zero. */
export function decimalString(
  value: Types.Decimal128 | null | undefined,
  places: number,
): string | null {
  if (value === null || value === undefined) return null
  return new HalfUp(value.toString()).toFixed(places)
}
