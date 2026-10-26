import { BarChart, LineChart } from 'echarts/charts'
import { AriaComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import type { EChartsCoreOption } from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'
import { useEffect, useRef } from 'react'

// Modular registration keeps the bundle to what the dashboards use.
echarts.use([
  BarChart,
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  AriaComponent,
  SVGRenderer,
])

interface EChartProps {
  option: EChartsCoreOption
  height: number
  /** Accessible name; ECharts also generates a data description (aria). */
  label: string
  onClickCategory?: (name: string) => void
}

export function EChart({ option, height, label, onClickCategory }: EChartProps) {
  const ref = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts | null>(null)
  const clickRef = useRef(onClickCategory)
  useEffect(() => {
    clickRef.current = onClickCategory
  }, [onClickCategory])

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const instance = echarts.init(element, undefined, { renderer: 'svg' })
    chart.current = instance
    // Whole-row hit target (bigger than the bar): map the click to a y-axis category.
    instance.getZr().on('click', (event: { offsetX: number; offsetY: number }) => {
      if (!clickRef.current) return
      const point = [event.offsetX, event.offsetY]
      if (!instance.containPixel({ gridIndex: 0 }, point)) return
      const [, index] = instance.convertFromPixel({ gridIndex: 0 }, point)
      const axis = (instance.getOption() as { yAxis?: { data?: string[] }[] }).yAxis?.[0]
      const name = axis?.data?.[Math.round(index ?? -1)]
      if (name) clickRef.current(name)
    })
    const observer = new ResizeObserver(() => {
      instance.resize()
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      instance.dispose()
      chart.current = null
    }
  }, [])

  useEffect(() => {
    chart.current?.setOption({ aria: { enabled: true }, animationDuration: 300, ...option }, true)
  }, [option])

  return (
    <div
      ref={ref}
      role="img"
      aria-label={label}
      style={{ height, width: '100%', cursor: onClickCategory ? 'pointer' : undefined }}
    />
  )
}
