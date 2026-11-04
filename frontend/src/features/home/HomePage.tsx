import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  BarChart3,
  ClipboardPen,
  ClipboardCheck,
  Map as MapIcon,
  Sprout,
  TreeDeciduous,
  Users,
  Wheat,
  type LucideIcon,
} from 'lucide-react'
import { Link } from 'react-router'

import { Alert, Card, EmptyState, IconTile, Stat } from '@/components/ui/display'
import { LoadingBlock } from '@/components/ui/Spinner'
import { stageColor } from '@/features/analytics/chartTheme'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { useAuth, type Capability } from '@/lib/auth/context'
import { formatHectares, formatNumber } from '@/lib/format'

type CommodityStat = Schemas['HomeCommodity']

const SHORTCUTS: { to: string; label: string; icon: LucideIcon; anyOf: Capability[] }[] = [
  { to: '/dashboard', label: 'Open dashboard', icon: BarChart3, anyOf: ['view_aggregates'] },
  { to: '/map', label: 'View the map', icon: MapIcon, anyOf: ['view_aggregates'] },
  { to: '/inventory/entry', label: 'New entry', icon: ClipboardPen, anyOf: ['edit_records'] },
]

/** Records waiting on this person. The API scopes the count to their assignment. */
function useWaiting(status: 'submitted' | 'validated' | null) {
  return useQuery({
    queryKey: ['inventory-records', 'waiting', status],
    enabled: status !== null,
    queryFn: async () =>
      unwrap(
        await api.GET('/api/v1/inventory-records', {
          params: { query: { page: 1, status: [status ?? 'submitted'] } },
        }),
      ),
  })
}

export default function HomePage() {
  const { user, can } = useAuth()
  const stats = useQuery({
    queryKey: ['stats', 'home'],
    queryFn: async () => unwrap(await api.GET('/api/v1/stats/home')),
  })
  const reviewStatus = can('validate') ? 'submitted' : can('approve') ? 'validated' : null
  const waiting = useWaiting(reviewStatus)
  const shortcuts = SHORTCUTS.filter((s) => s.anyOf.some((cap) => can(cap)))

  return (
    <div className="space-y-6">
      <section className="surface-forest relative overflow-hidden rounded-3xl p-6 shadow-raised sm:p-8">
        <Sprout
          aria-hidden="true"
          strokeWidth={0.75}
          className="pointer-events-none absolute -right-8 -bottom-12 h-64 w-64 text-white/10"
        />
        <div className="relative">
          <h1 className="text-[28px] leading-tight font-extrabold sm:text-[34px]">
            Welcome{user?.first_name ? `, ${user.first_name}` : ''}
          </h1>
          <p className="mt-1.5 max-w-xl text-sm text-brand-100">
            Figures are computed from approved records within your assignment.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            {shortcuts.map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-3.5 py-2 text-sm font-semibold text-white ring-1 ring-inset ring-white/15 transition hover:bg-white/20 focus-visible:outline-white"
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {label}
              </Link>
            ))}
          </div>
        </div>
      </section>

      {waiting.data && waiting.data.count > 0 ? (
        <Link
          to="/review"
          className="surface-card group flex items-center gap-4 p-4 transition hover:shadow-raised"
        >
          <IconTile icon={ClipboardCheck} tone="harvest" />
          <span className="min-w-0 flex-1">
            <span className="block font-display font-bold text-ink">
              {formatNumber(waiting.data.count)}{' '}
              {waiting.data.count === 1 ? 'record is' : 'records are'} waiting for your review
            </span>
            <span className="block text-[13px] text-muted">Oldest first, in the review queue</span>
          </span>
          <ArrowRight
            className="h-5 w-5 shrink-0 text-muted transition group-hover:translate-x-0.5 group-hover:text-brand-700"
            aria-hidden="true"
          />
        </Link>
      ) : null}

      {stats.isPending ? (
        <LoadingBlock />
      ) : stats.isError ? (
        <Alert tone="error">Could not load the summary.</Alert>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Stat label="Farmers" value={formatNumber(stats.data.farmers)} icon={Users} />
            <Stat
              label="Farms"
              value={formatNumber(stats.data.farms)}
              icon={Wheat}
              tone="harvest"
            />
          </div>
          {stats.data.commodities.length === 0 ? (
            <EmptyState title="No approved inventory yet" icon={TreeDeciduous}>
              Totals appear here once records are approved.
            </EmptyState>
          ) : (
            stats.data.commodities.map((c) => <CommodityCard key={c.commodity.id} stat={c} />)
          )}
        </>
      )}
    </div>
  )
}

function CommodityCard({ stat }: { stat: CommodityStat }) {
  const total = Math.max(1, stat.total)
  return (
    <Card title={stat.commodity.name} description={stat.round.name} icon={TreeDeciduous}>
      <div className="grid gap-6 lg:grid-cols-[14rem_1fr] lg:items-center">
        <div className="flex gap-8 lg:flex-col lg:gap-4">
          <div>
            <p className="text-[13px] font-medium text-muted">Trees</p>
            <p className="font-display text-4xl font-extrabold">{formatNumber(stat.total)}</p>
          </div>
          <div>
            <p className="text-[13px] font-medium text-muted">Area (derived)</p>
            <p className="font-display text-2xl font-bold">{formatHectares(stat.total_area_ha)}</p>
          </div>
        </div>
        <table className="w-full text-sm">
          <caption className="sr-only">Trees by growth stage</caption>
          <thead className="sr-only">
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">Share</th>
              <th scope="col">Trees</th>
              <th scope="col">Area</th>
            </tr>
          </thead>
          <tbody>
            {stat.stages.map((s, i) => (
              <tr key={s.code}>
                <th scope="row" className="w-24 py-2 pr-3 text-left font-medium">
                  {s.label}
                </th>
                <td className="py-2 pr-4" aria-hidden="true">
                  <div className="h-2.5 overflow-hidden rounded-full bg-sunken">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${String((s.count / total) * 100)}%`,
                        background: stageColor(i, stat.stages.length),
                      }}
                    />
                  </div>
                </td>
                <td className="w-16 py-2 text-right font-semibold tabular-nums">
                  {formatNumber(s.count)}
                </td>
                <td className="w-20 py-2 text-right text-muted tabular-nums">
                  {formatHectares(s.area_ha)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
