import { describe, expect, it } from 'vitest'

import { stageColor, STAGE_RAMP } from './chartTheme'
import { stackedByArea, yearBuckets } from './charts'

describe('yearBuckets', () => {
  it('folds early years and fills gaps so spacing reflects time', () => {
    expect(
      yearBuckets([
        { year: 1980, stands: 1 },
        { year: 2007, stands: 2 },
        { year: 2016, stands: 5 },
        { year: 2018, stands: 3 },
      ]),
    ).toEqual([
      { label: '<2010', value: 3 },
      { label: '2016', value: 5 },
      { label: '2017', value: 0 },
      { label: '2018', value: 3 },
    ])
  })

  it('handles empty and early-only data', () => {
    expect(yearBuckets([])).toEqual([])
    expect(yearBuckets([{ year: 1999, stands: 4 }])).toEqual([{ label: '<2010', value: 4 }])
  })
})

describe('stage colours', () => {
  it('spread ordered stages over the validated ramp, light to dark', () => {
    expect([0, 1, 2, 3].map((i) => stageColor(i, 4))).toEqual([...STAGE_RAMP])
    expect(stageColor(0, 2)).toBe(STAGE_RAMP[0])
    expect(stageColor(1, 2)).toBe(STAGE_RAMP[3])
  })
})

describe('stackedByArea', () => {
  it('stacks one series per stage, largest area on top, rounded end on the last segment', () => {
    const option = stackedByArea(
      [
        { name: 'Big', stages: { A: 10, B: 5 } },
        { name: 'Small', stages: { A: 1 } },
      ],
      [
        { code: 'A', label: 'Stage A' },
        { code: 'B', label: 'Stage B' },
      ],
    ) as {
      yAxis: { data: string[] }
      series: { data: number[]; itemStyle: { borderRadius: unknown } }[]
    }

    expect(option.yAxis.data).toEqual(['Small', 'Big'])
    expect(option.series.map((s) => s.data)).toEqual([
      [1, 10],
      [0, 5],
    ])
    expect(option.series[0]?.itemStyle.borderRadius).toBe(0)
    expect(option.series[1]?.itemStyle.borderRadius).toEqual([0, 4, 4, 0])
  })
})
