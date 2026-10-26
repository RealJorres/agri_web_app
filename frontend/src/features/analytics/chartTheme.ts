/**
 * Chart tokens from the validated reference palette (dataviz skill, references/palette.md).
 * Growth stages are ORDERED, so they use the one-hue ordinal ramp (blue 250/400/550/700),
 * validated with `validate_palette.js --ordinal --surface #ffffff`: all checks pass.
 */
export const STAGE_RAMP = ['#86b6ef', '#3987e5', '#1c5cab', '#0d366b'] as const

/** Single-series charts use categorical slot 1. */
export const SERIES_1 = '#2a78d6'

export const INK = {
  primary: '#0b0b0b',
  secondary: '#52514e',
  muted: '#6b6a65',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  surface: '#ffffff',
  good: '#006300',
  bad: '#b8322f',
} as const

export function stageColor(index: number, count: number): string {
  if (count <= 1) return STAGE_RAMP[2]
  // Spread the stages over the ramp so 2-6 stages stay monotone and distinct.
  const position = Math.round((index * (STAGE_RAMP.length - 1)) / (count - 1))
  return STAGE_RAMP[Math.min(STAGE_RAMP.length - 1, position)] ?? STAGE_RAMP[0]
}

export const compact = new Intl.NumberFormat('en-PH', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

export const BASE_TEXT = {
  color: INK.secondary,
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  fontSize: 12,
}

/** Shared axis styling: hairline solid grid, recessive axis, muted labels. */
export const valueAxis = {
  type: 'value' as const,
  axisLabel: { ...BASE_TEXT, color: INK.muted, formatter: (v: number) => compact.format(v) },
  splitLine: { lineStyle: { color: INK.grid, width: 1, type: 'solid' as const } },
  axisLine: { show: false },
  axisTick: { show: false },
}

export const categoryAxis = {
  type: 'category' as const,
  axisLabel: { ...BASE_TEXT },
  axisLine: { lineStyle: { color: INK.axis } },
  axisTick: { show: false },
}

export const tooltipBase = {
  backgroundColor: '#ffffff',
  borderColor: 'rgba(11,11,11,0.10)',
  textStyle: { ...BASE_TEXT, color: INK.primary },
  extraCssText: 'box-shadow: 0 2px 8px rgba(0,0,0,.08); border-radius: 6px;',
}
