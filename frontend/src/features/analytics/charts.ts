/** ECharts option builders. Pure functions of data, so they are unit-testable. */
import type { EChartsCoreOption } from 'echarts/core'

import {
  BASE_TEXT,
  INK,
  SERIES_1,
  categoryAxis,
  compact,
  stageColor,
  tooltipBase,
  valueAxis,
} from './chartTheme'

export interface StageDef {
  code: string
  label: string
}

const BAR = { barMaxWidth: 24 }
// 2px surface gap between touching fills (spec: gap, never an outline).
const GAP = { borderColor: INK.surface, borderWidth: 1 }

/** Horizontal stacked bars: one row per area, one segment per stage (ordinal ramp). */
export function stackedByArea(
  rows: { name: string; stages: Record<string, number> }[],
  stages: StageDef[],
): EChartsCoreOption {
  const ordered = [...rows].reverse() // largest at the top
  return {
    grid: { left: 8, right: 56, top: 8, bottom: 8, containLabel: true },
    tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: valueAxis,
    yAxis: { ...categoryAxis, data: ordered.map((r) => r.name) },
    series: stages.map((stage, i) => ({
      name: stage.label,
      type: 'bar',
      stack: 'trees',
      ...BAR,
      itemStyle: {
        color: stageColor(i, stages.length),
        ...GAP,
        // Rounded data-end only on the outermost segment, square at the baseline.
        borderRadius: i === stages.length - 1 ? [0, 4, 4, 0] : 0,
      },
      emphasis: { focus: 'series' },
      label:
        i === stages.length - 1
          ? {
              show: true,
              position: 'right',
              ...BASE_TEXT,
              formatter: (p: { dataIndex: number }) => {
                const row = ordered[p.dataIndex]
                const total = row ? Object.values(row.stages).reduce((a, b) => a + b, 0) : 0
                return compact.format(total)
              },
            }
          : { show: false },
      data: ordered.map((r) => r.stages[stage.code] ?? 0),
    })),
  }
}

/** Single part-to-whole bar: the stage mix of the whole round. */
export function stageMix(stages: (StageDef & { trees: number })[]): EChartsCoreOption {
  const total = stages.reduce((a, s) => a + s.trees, 0)
  return {
    grid: { left: 0, right: 0, top: 0, bottom: 0 },
    tooltip: {
      ...tooltipBase,
      trigger: 'item',
      formatter: (p: { seriesName: string; value: number }) =>
        `${p.seriesName}: ${p.value.toLocaleString('en-PH')} (${total ? ((p.value / total) * 100).toFixed(1) : '0'}%)`,
    },
    xAxis: { type: 'value', max: total || 1, show: false },
    yAxis: { type: 'category', data: ['Trees'], show: false },
    series: stages.map((s, i) => ({
      name: s.label,
      type: 'bar',
      stack: 'mix',
      barWidth: 24,
      itemStyle: {
        color: stageColor(i, stages.length),
        ...GAP,
        borderRadius: i === stages.length - 1 ? [0, 4, 4, 0] : i === 0 ? [4, 0, 0, 4] : 0,
      },
      data: [s.trees],
    })),
  }
}

/** Single-series columns (farm sizes, planting years): slot-1 colour, no legend. */
export function columns(labels: string[], values: number[], name: string): EChartsCoreOption {
  // Many buckets: rotate rather than skip or overlap labels.
  const characters = labels.reduce((sum, label) => sum + label.length, 0)
  const rotate = labels.length > 8 || characters > 30 ? 45 : 0
  return {
    grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
    tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow' } },
    // Every bucket is labelled: skipped labels make ordered buckets ambiguous.
    xAxis: {
      ...categoryAxis,
      data: labels,
      axisLabel: { ...categoryAxis.axisLabel, interval: 0, rotate },
    },
    yAxis: valueAxis,
    series: [
      {
        name,
        type: 'bar',
        ...BAR,
        itemStyle: { color: SERIES_1, borderRadius: [4, 4, 0, 0], ...GAP },
        data: values,
      },
    ],
  }
}

/** Single-series horizontal bars (varieties). */
export function bars(labels: string[], values: number[], name: string): EChartsCoreOption {
  return {
    grid: { left: 8, right: 40, top: 8, bottom: 8, containLabel: true },
    tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: valueAxis,
    yAxis: { ...categoryAxis, data: [...labels].reverse() },
    series: [
      {
        name,
        type: 'bar',
        ...BAR,
        itemStyle: { color: SERIES_1, borderRadius: [0, 4, 4, 0], ...GAP },
        label: { show: true, position: 'right', ...BASE_TEXT },
        data: [...values].reverse(),
      },
    ],
  }
}

/** One line over rounds (2px line, >=8px markers with a surface ring, end label). */
export function trendLine(labels: string[], values: number[], name: string): EChartsCoreOption {
  return {
    grid: { left: 8, right: 48, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      ...tooltipBase,
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: INK.axis } },
    },
    xAxis: { ...categoryAxis, data: labels, boundaryGap: false },
    yAxis: valueAxis,
    series: [
      {
        name,
        type: 'line',
        data: values,
        lineStyle: { width: 2, color: SERIES_1, cap: 'round', join: 'round' },
        itemStyle: { color: SERIES_1, borderColor: INK.surface, borderWidth: 2 },
        symbolSize: 9,
        areaStyle: { color: SERIES_1, opacity: 0.08 },
        endLabel: {
          show: true,
          ...BASE_TEXT,
          formatter: (p: { value: number }) => compact.format(p.value),
        },
      },
    ],
  }
}

/**
 * Contiguous planting-year buckets for a category axis: years before `from` fold into one
 * "<from" bucket and gaps are filled with 0, so equal spacing never hides elapsed time.
 */
export function yearBuckets(
  years: { year: number; stands: number }[],
  from = 2010,
): { label: string; value: number }[] {
  if (years.length === 0) return []
  const early = years.filter((y) => y.year < from).reduce((sum, y) => sum + y.stands, 0)
  const recent = years.filter((y) => y.year >= from)
  const out: { label: string; value: number }[] = early
    ? [{ label: `<${String(from)}`, value: early }]
    : []
  if (recent.length === 0) return out
  const byYear = new Map(recent.map((y) => [y.year, y.stands]))
  const first = Math.min(...recent.map((y) => y.year))
  const last = Math.max(...recent.map((y) => y.year))
  for (let year = first; year <= last; year += 1) {
    out.push({ label: String(year), value: byYear.get(year) ?? 0 })
  }
  return out
}
