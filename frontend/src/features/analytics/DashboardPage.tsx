import { ArrowDown, ArrowUp } from 'lucide-react'
import { useMemo } from 'react'
import { useSearchParams } from 'react-router'

import { Alert, EmptyState, PageHeader } from '@/components/ui/display'
import { SelectInput } from '@/components/ui/fields'
import { LoadingBlock } from '@/components/ui/Spinner'
import { HarvestSummaryCard } from '@/features/harvests/HarvestSummaryCard'
import type { Schemas } from '@/lib/api/client'
import { errorMessage } from '@/lib/forms'
import { formatDateTime, formatHectares, formatNumber } from '@/lib/format'
import { useMunicipalities, useRounds } from '@/lib/reference'

import { useAnalyticsStatus, useBreakdown, useDistribution, useOverview, useTrends } from './api'
import { ChartCard, StageLegend } from './ChartCard'
import { INK, stageColor } from './chartTheme'
import { bars, columns, stackedByArea, stageMix, trendLine, yearBuckets } from './charts'
import { EChart } from './EChart'

type Overview = Schemas['Overview']

export default function DashboardPage() {
  const [params, setParams] = useSearchParams()
  const rounds = useRounds()
  const municipalities = useMunicipalities()
  const status = useAnalyticsStatus()

  const roundList = rounds.data?.results ?? []
  const roundId =
    params.get('round') ??
    roundList.find((r) => r.status === 'closed' || r.is_historical)?.id ??
    roundList[0]?.id
  const round = roundList.find((r) => r.id === roundId)
  const municipality = params.get('municipality') ?? undefined
  const town = municipalities.data?.find((m) => m.id === municipality)

  const overview = useOverview(roundId, municipality)
  const breakdown = useBreakdown(roundId, municipality)
  const distribution = useDistribution(roundId, municipality)
  const trends = useTrends(round?.commodity, municipality)

  const set = (key: string, value: string | null) => {
    setParams((current) => {
      const next = new URLSearchParams(current)
      if (value) next.set(key, value)
      else next.delete(key)
      return next
    })
  }

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={
          status.data?.refreshed_at
            ? `Approved records only · data as of ${formatDateTime(status.data.refreshed_at)}`
            : 'Approved records only'
        }
      />
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:max-w-2xl">
        <SelectInput
          label="Survey round"
          value={roundId ?? ''}
          onChange={(e) => set('round', e.target.value || null)}
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
          onChange={(e) => set('municipality', e.target.value || null)}
        >
          <option value="">All in my assignment</option>
          {municipalities.data?.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </SelectInput>
      </div>
      {rounds.isPending || overview.isPending ? (
        roundList.length === 0 && !rounds.isPending ? (
          <EmptyState title="No survey rounds yet" />
        ) : (
          <LoadingBlock />
        )
      ) : overview.isError ? (
        <Alert tone="error">{errorMessage(overview.error)}</Alert>
      ) : overview.data.records === 0 ? (
        <EmptyState title="No approved records in this round yet" />
      ) : (
        <div className="space-y-6">
          <StatTiles overview={overview.data} town={town?.name} />
          <StageMixCard overview={overview.data} />
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <BreakdownCard
              overview={overview.data}
              rows={breakdown.data ?? []}
              loading={breakdown.isPending}
              town={town?.name}
              onDrill={(name) => {
                const target = municipalities.data?.find((m) => m.name === name)
                if (target && !municipality) set('municipality', target.id)
              }}
            />
            <TrendCard points={trends.data ?? []} town={town?.name} />
          </div>
          {distribution.data ? <Distributions data={distribution.data} /> : null}
        </div>
      )}
      <div className="mt-6">
        <HarvestSummaryCard commodity={round?.commodity} town={town?.name} />
      </div>
    </>
  )
}

function Delta({
  value,
  unit = '',
  suffix,
}: {
  value: number | null
  unit?: string
  suffix?: string
}) {
  if (value === null) return <span className="text-muted">No earlier round</span>
  const up = value > 0
  const Icon = up ? ArrowUp : ArrowDown
  if (value === 0) return <span className="text-muted">No change {suffix}</span>
  return (
    <span
      className="inline-flex items-center gap-0.5 font-medium"
      style={{ color: up ? INK.good : INK.bad }}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {up ? '+' : '−'}
      {formatNumber(Math.abs(value))}
      {unit} <span className="font-normal text-muted">{suffix}</span>
    </span>
  )
}

function StatTiles({ overview: o, town }: { overview: Overview; town?: string | undefined }) {
  const vs = o.previous_round ? `vs ${o.previous_round.name}` : ''
  const share = o.bearing_share === null ? '—' : `${(o.bearing_share * 100).toFixed(1)}%`
  const shareChange =
    o.change.bearing_share === null ? null : Math.round(o.change.bearing_share * 1000) / 10
  return (
    <section
      aria-label="Headline figures"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
    >
      <div className="rounded-lg border border-line bg-surface p-4 shadow-sm sm:col-span-2 lg:col-span-1">
        <p className="text-sm text-muted">Trees{town ? ` in ${town}` : ''}</p>
        <p className="mt-1 text-5xl font-semibold text-ink">{formatNumber(o.trees)}</p>
        <p className="mt-2 text-sm">
          <Delta value={o.change.trees} suffix={vs} />
        </p>
      </div>
      <Tile
        label="Area (derived)"
        value={formatHectares(o.area_ha)}
        hint="trees ÷ plants per hectare"
      />
      <Tile
        label="Farmers"
        value={formatNumber(o.farmers)}
        hint={<Delta value={o.change.farmers} suffix={vs} />}
      />
      <Tile
        label="Bearing trees"
        value={share}
        hint={
          shareChange === null ? (
            `${formatNumber(o.bearing_trees)} in bearing stages`
          ) : (
            <Delta value={shareChange} unit=" pts" suffix={vs} />
          )
        }
      />
    </section>
  )
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4 shadow-sm">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-ink">{value}</p>
      {hint ? <p className="mt-2 text-sm text-muted">{hint}</p> : null}
    </div>
  )
}

function legendFor(stages: { label: string }[]) {
  return stages.map((s, i) => ({ label: s.label, color: stageColor(i, stages.length) }))
}

function StageMixCard({ overview: o }: { overview: Overview }) {
  const option = useMemo(() => stageMix(o.stages), [o.stages])
  return (
    <ChartCard
      title="Growth stage mix"
      subtitle={`${o.round.name} · share of ${formatNumber(o.trees)} trees`}
      filename="stage-mix.csv"
      legend={<StageLegend stages={legendFor(o.stages)} />}
      table={{
        columns: ['Stage', 'Trees', 'Area (ha)', 'Share %', 'Change'],
        rows: o.stages.map((s) => [
          s.label,
          s.trees,
          s.area_ha ?? null,
          o.trees ? Math.round((s.trees / o.trees) * 1000) / 10 : 0,
          s.change ?? null,
        ]),
      }}
    >
      <EChart option={option} height={32} label="Share of trees by growth stage" />
      <ul className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        {o.stages.map((s) => (
          <li key={s.code}>
            <span className="text-muted">{s.label}</span>{' '}
            <span className="font-medium text-ink">{formatNumber(s.trees)}</span>{' '}
            <span className="text-muted">
              ({o.trees ? ((s.trees / o.trees) * 100).toFixed(0) : 0}%)
            </span>
          </li>
        ))}
      </ul>
    </ChartCard>
  )
}

function BreakdownCard({
  overview: o,
  rows,
  loading,
  town,
  onDrill,
}: {
  overview: Overview
  rows: Schemas['BreakdownRow'][]
  loading: boolean
  town?: string | undefined
  onDrill: (name: string) => void
}) {
  const option = useMemo(() => stackedByArea(rows, o.stages), [rows, o.stages])
  const level = town ? 'barangay' : 'municipality'
  return (
    <ChartCard
      title={town ? `Trees by barangay: ${town}` : 'Trees by municipality'}
      subtitle={town ? 'Select "All" above to go back.' : 'Select a bar to see its barangays.'}
      filename={`trees-by-${level}.csv`}
      legend={<StageLegend stages={legendFor(o.stages)} />}
      table={{
        columns: [
          town ? 'Barangay' : 'Municipality',
          ...o.stages.map((s) => s.label),
          'Total',
          'Farmers',
          'Area (ha)',
        ],
        rows: rows.map((r) => [
          r.name,
          ...o.stages.map((s) => r.stages[s.code] ?? 0),
          r.trees,
          r.farmers,
          r.area_ha ?? null,
        ]),
      }}
    >
      {loading ? (
        <LoadingBlock />
      ) : (
        <EChart
          option={option}
          height={Math.max(160, rows.length * 34 + 24)}
          label={`Trees by ${level} and growth stage`}
          onClickCategory={town ? undefined : onDrill}
        />
      )}
    </ChartCard>
  )
}

function TrendCard({
  points,
  town,
}: {
  points: Schemas['TrendPoint'][]
  town?: string | undefined
}) {
  const option = useMemo(
    () =>
      trendLine(
        points.map((p) => p.round.name),
        points.map((p) => p.trees),
        'Trees',
      ),
    [points],
  )
  return (
    <ChartCard
      title={town ? `Trees over time: ${town}` : 'Trees over time'}
      subtitle="Approved trees per survey round"
      filename="trees-over-time.csv"
      table={{
        columns: ['Round', 'As of', 'Trees', 'Farmers', 'Bearing %'],
        rows: points.map((p) => [
          p.round.name,
          p.as_of_date,
          p.trees,
          p.farmers,
          p.bearing_share === null ? null : Math.round(p.bearing_share * 1000) / 10,
        ]),
      }}
    >
      {points.length < 2 ? (
        <EmptyState title="Only one round so far">
          The trend appears once a second round is approved.
        </EmptyState>
      ) : (
        <EChart option={option} height={240} label="Trees per survey round" />
      )}
    </ChartCard>
  )
}

function Distributions({ data }: { data: Schemas['Distribution'] }) {
  const sizes = useMemo(
    () =>
      columns(
        data.farm_sizes.map((b) => b.label),
        data.farm_sizes.map((b) => b.farms),
        'Farms',
      ),
    [data.farm_sizes],
  )
  const years = useMemo(() => {
    const buckets = yearBuckets(data.planting_years)
    return columns(
      buckets.map((b) => b.label),
      buckets.map((b) => b.value),
      'Farms',
    )
  }, [data.planting_years])
  const varieties = useMemo(
    () =>
      bars(
        data.varieties.map((v) => v.name),
        data.varieties.map((v) => v.stands),
        'Farms',
      ),
    [data.varieties],
  )
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <ChartCard
        title="Farm size"
        subtitle="Farms by number of trees"
        filename="farm-sizes.csv"
        table={{
          columns: ['Trees per farm', 'Farms'],
          rows: data.farm_sizes.map((b) => [b.label, b.farms]),
        }}
      >
        <EChart option={sizes} height={220} label="Farms by number of trees" />
      </ChartCard>
      <ChartCard
        title="Planting year"
        subtitle={`Farms with a planting in each year · ${formatNumber(data.planting_year_unknown)} unknown`}
        filename="planting-years.csv"
        table={{
          columns: ['Year', 'Farms'],
          rows: [
            ...data.planting_years.map((y) => [String(y.year), y.stands] as (string | number)[]),
            ['Unknown', data.planting_year_unknown],
          ],
        }}
      >
        {data.planting_years.length ? (
          <EChart option={years} height={220} label="Farms by planting year" />
        ) : (
          <EmptyState title="No planting years recorded" />
        )}
      </ChartCard>
      <ChartCard
        title="Varieties"
        subtitle={`Farms growing each variety · ${formatNumber(data.variety_unknown)} not recorded`}
        filename="varieties.csv"
        table={{
          columns: ['Variety', 'Farms'],
          rows: [
            ...data.varieties.map((v) => [v.name, v.stands] as (string | number)[]),
            ['Not recorded', data.variety_unknown],
          ],
        }}
      >
        {data.varieties.length ? (
          <EChart
            option={varieties}
            height={Math.max(160, data.varieties.length * 34 + 24)}
            label="Farms by variety"
          />
        ) : (
          <EmptyState title="No varieties recorded" />
        )}
      </ChartCard>
    </div>
  )
}
