/**
 * Chart tokens from the validated reference palette (dataviz skill, references/palette.md).
 * Growth stages are ORDERED, so they use a one-hue ordinal ramp in the app's green,
 * validated with `validate_palette.js --ordinal --surface #ffffff`: all checks pass.
 */
export const STAGE_RAMP = ['#7cc492', '#3f9f6b', '#1f7a54', '#0c4a34'] as const

/** Single-series charts use categorical slot 1. */
export const SERIES_1 = '#1f7a54'

export const INK = {
  primary: '#1b2420',
  secondary: '#4b554f',
  muted: '#59635d',
  grid: '#eeede7',
  axis: '#c9c8bd',
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
  fontFamily: '"Inter Variable", system-ui, -apple-system, "Segoe UI", sans-serif',
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
  extraCssText: 'box-shadow: 0 8px 24px -8px rgba(27,36,32,.25); border-radius: 10px;',
}
