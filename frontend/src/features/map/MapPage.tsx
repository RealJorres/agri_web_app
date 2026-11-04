import { Download } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import { Alert, Card, EmptyState, FilterBar, PageHeader } from '@/components/ui/display'
import { SelectInput } from '@/components/ui/fields'
import { LoadingBlock } from '@/components/ui/Spinner'
import { StageLegend } from '@/features/analytics/ChartCard'
import { useAuth } from '@/lib/auth/context'
import { downloadCsv } from '@/lib/csv'
import { errorMessage } from '@/lib/forms'
import { formatNumber } from '@/lib/format'
import { useMunicipalities, useRounds } from '@/lib/reference'

import { useAreaFigures, useBoundaries, useFarmPoints, useMapConfig } from './api'
import { ChoroplethMap } from './ChoroplethMap'
import {
  classify,
  fillExpression,
  formatMetric,
  metricValue,
  type AreaFigure,
  type AreaLevel,
  type Metric,
} from './geo'

const NO_FARMS: never[] = []

export default function MapPage() {
  const [params, setParams] = useSearchParams()
  const { can } = useAuth()
  const rounds = useRounds()
  const municipalities = useMunicipalities()
  const config = useMapConfig()

  const roundList = rounds.data?.results ?? []
  const roundId =
    params.get('round') ??
    roundList.find((r) => r.status === 'closed' || r.is_historical)?.id ??
    roundList[0]?.id
  const municipality = params.get('municipality') ?? undefined
  const level: AreaLevel = params.get('level') === 'barangay' ? 'barangay' : 'municipality'
  const metric: Metric = params.get('metric') === 'bearing_share' ? 'bearing_share' : 'trees'

  const set = (values: Record<string, string | null>) => {
    setParams((current) => {
      const next = new URLSearchParams(current)
      Object.entries(values).forEach(([key, value]) => {
        if (value) next.set(key, value)
        else next.delete(key)
      })
      return next
    })
  }

  const loaded =
    level === 'barangay'
      ? (config.data?.barangay_boundaries ?? 0)
      : (config.data?.municipality_boundaries ?? 0)
  const boundaries = useBoundaries(level, municipality, loaded > 0)
  const figures = useAreaFigures(roundId, level, municipality)

  const canSeeFarms = can('view_personal_data')
  const [showFarms, setShowFarms] = useState(true)
  const points = useFarmPoints(municipality, canSeeFarms)
  const [chosenFarm, setChosenFarm] = useState<string | null>(null)
  const farm = points.data?.results.find((p) => p.id === chosenFarm)

  const rows: AreaFigure[] = useMemo(() => figures.data ?? [], [figures.data])
  const classes = useMemo(() => classify(rows, metric), [rows, metric])
  const fill = useMemo(() => fillExpression(rows, classes), [rows, classes])
  const figureById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows])

  const describeArea = (id: string, name: string) => {
    const figure = figureById.get(id)
    return `${name}: ${figure ? formatMetric(metricValue(figure, metric), metric) : 'no official data in your view'}`
  }

  const drill = (id: string) => {
    if (level === 'municipality') set({ municipality: id, level: 'barangay' })
  }

  const metricLabel = metric === 'trees' ? 'Trees' : 'Bearing share'

  return (
    <>
      <PageHeader
        title="Map"
        description="Figures come from approved records in your assignment."
      />
      <FilterBar className="sm:grid-cols-2 xl:grid-cols-4">
        <SelectInput
          label="Survey round"
          value={roundId ?? ''}
          onChange={(e) => set({ round: e.target.value || null })}
        >
          {roundList.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </SelectInput>
        <SelectInput
          label="Municipality"
          value={municipality ?? ''}
          onChange={(e) => set({ municipality: e.target.value || null })}
        >
          <option value="">All in my assignment</option>
          {municipalities.data?.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </SelectInput>
        <SelectInput
          label="Show by"
          value={level}
          onChange={(e) => set({ level: e.target.value === 'barangay' ? 'barangay' : null })}
        >
          <option value="municipality">Municipality</option>
          <option value="barangay">Barangay</option>
        </SelectInput>
        <SelectInput
          label="Colour by"
          value={metric}
          onChange={(e) =>
            set({ metric: e.target.value === 'bearing_share' ? 'bearing_share' : null })
          }
        >
          <option value="trees">Number of trees</option>
          <option value="bearing_share">Share of trees bearing</option>
        </SelectInput>
      </FilterBar>

      <div className="space-y-6">
        <Card title="Map">
          {config.isPending ? (
            <LoadingBlock />
          ) : config.isError ? (
            <Alert tone="error">{errorMessage(config.error)}</Alert>
          ) : (
            <div className="space-y-3">
              {loaded === 0 ? (
                <Alert tone="info">
                  Official {level} boundaries have not been loaded yet, so areas are not drawn. The
                  figures are in the table below.
                </Alert>
              ) : null}
              {boundaries.isError ? (
                <Alert tone="error">{errorMessage(boundaries.error)}</Alert>
              ) : null}
              {points.isError ? <Alert tone="error">{errorMessage(points.error)}</Alert> : null}
              {loaded > 0 && classes.legend.length ? (
                <div>
                  <p className="mb-1 text-xs font-medium text-muted">{metricLabel}</p>
                  <StageLegend
                    stages={classes.legend.map((entry) => ({
                      label: entry.label,
                      color: entry.color,
                    }))}
                  />
                  <p className="text-xs text-muted">
                    Areas with no colour have no official data in your view.
                  </p>
                </div>
              ) : null}
              {canSeeFarms ? (
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={showFarms}
                    onChange={(e) => {
                      setShowFarms(e.target.checked)
                      setChosenFarm(null)
                    }}
                  />
                  Show farm locations
                  {points.data ? (
                    <span className="text-muted">
                      ({formatNumber(points.data.located)} of{' '}
                      {formatNumber(points.data.total_farms)} farms have a location)
                    </span>
                  ) : null}
                </label>
              ) : null}
              <ChoroplethMap
                config={config.data}
                areas={loaded > 0 ? boundaries.data : undefined}
                fill={fill}
                describeArea={describeArea}
                points={showFarms ? (points.data?.results ?? NO_FARMS) : NO_FARMS}
                onAreaClick={drill}
                onPointClick={setChosenFarm}
              />
              {farm ? (
                <p className="text-sm text-ink" role="status">
                  Farm in {farm.barangay}, {farm.municipality}.{' '}
                  <Link
                    to={`/farmers/${farm.farmer}`}
                    className="font-medium text-brand-800 hover:underline"
                  >
                    Open farmer
                  </Link>
                </p>
              ) : null}
            </div>
          )}
        </Card>

        <AreaTable
          level={level}
          rows={rows}
          pending={figures.isPending && Boolean(roundId)}
          error={figures.isError ? errorMessage(figures.error) : null}
        />
      </div>
    </>
  )
}

function AreaTable({
  level,
  rows,
  pending,
  error,
}: {
  level: AreaLevel
  rows: AreaFigure[]
  pending: boolean
  error: string | null
}) {
  const heading = level === 'barangay' ? 'Barangay' : 'Municipality'
  const toRow = (r: AreaFigure) => [
    r.name,
    r.trees,
    r.bearing_share === null ? null : Math.round(r.bearing_share * 100),
  ]
  return (
    <Card
      title={`Figures by ${level}`}
      actions={
        <button
          type="button"
          disabled={rows.length === 0}
          onClick={() =>
            downloadCsv(`map-${level}.csv`, [heading, 'Trees', 'Bearing %'], rows.map(toRow))
          }
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-ink hover:bg-sunken disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          CSV
        </button>
      }
    >
      {pending ? (
        <LoadingBlock />
      ) : error ? (
        <Alert tone="error">{error}</Alert>
      ) : rows.length === 0 ? (
        <EmptyState title="No approved records here yet" />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <caption className="sr-only">Figures by {level}</caption>
            <thead>
              <tr className="text-left text-muted">
                <th scope="col" className="py-1.5 pr-4 font-medium">
                  {heading}
                </th>
                <th scope="col" className="py-1.5 pr-4 text-right font-medium">
                  Trees
                </th>
                <th scope="col" className="py-1.5 pr-4 text-right font-medium">
                  Bearing
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <th scope="row" className="py-1.5 pr-4 text-left font-normal">
                    {r.name}
                  </th>
                  <td className="py-1.5 pr-4 text-right tabular-nums">{formatNumber(r.trees)}</td>
                  <td className="py-1.5 pr-4 text-right tabular-nums">
                    {r.bearing_share === null
                      ? '—'
                      : `${String(Math.round(r.bearing_share * 100))}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
