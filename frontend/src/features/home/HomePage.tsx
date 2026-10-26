import { useQuery } from '@tanstack/react-query'

import { Alert, Card, EmptyState, PageHeader, Stat } from '@/components/ui/display'
import { LoadingBlock } from '@/components/ui/Spinner'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { useAuth } from '@/lib/auth/context'
import { formatHectares, formatNumber } from '@/lib/format'

type CommodityStat = Schemas['HomeCommodity']

export default function HomePage() {
  const { user } = useAuth()
  const stats = useQuery({
    queryKey: ['stats', 'home'],
    queryFn: async () => unwrap(await api.GET('/api/v1/stats/home')),
  })

  return (
    <>
      <PageHeader
        title={`Welcome${user?.first_name ? `, ${user.first_name}` : ''}`}
        description="Figures are computed from approved records within your assignment."
      />
      {stats.isPending ? (
        <LoadingBlock />
      ) : stats.isError ? (
        <Alert tone="error">Could not load the summary.</Alert>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Stat label="Farmers" value={formatNumber(stats.data.farmers)} />
            <Stat label="Farms" value={formatNumber(stats.data.farms)} />
          </div>
          {stats.data.commodities.length === 0 ? (
            <EmptyState title="No approved inventory yet">
              Totals appear here once records are approved.
            </EmptyState>
          ) : (
            stats.data.commodities.map((c) => <CommodityCard key={c.commodity.id} stat={c} />)
          )}
        </div>
      )}
    </>
  )
}

function CommodityCard({ stat }: { stat: CommodityStat }) {
  const max = Math.max(1, ...stat.stages.map((s) => s.count))
  return (
    <Card title={`${stat.commodity.name}: ${stat.round.name}`}>
      <div className="mb-4 flex flex-wrap gap-6">
        <div>
          <p className="text-sm text-muted">Trees</p>
          <p className="text-2xl font-semibold">{formatNumber(stat.total)}</p>
        </div>
        <div>
          <p className="text-sm text-muted">Area (derived)</p>
          <p className="text-2xl font-semibold">{formatHectares(stat.total_area_ha)}</p>
        </div>
      </div>
      <table className="w-full text-sm">
        <caption className="sr-only">Trees by growth stage</caption>
        <thead>
          <tr className="text-left text-muted">
            <th scope="col" className="py-1 font-medium">
              Stage
            </th>
            <th scope="col" className="w-1/2 py-1 font-medium">
              <span className="sr-only">Share</span>
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              Trees
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              Area
            </th>
          </tr>
        </thead>
        <tbody>
          {stat.stages.map((s) => (
            <tr key={s.code} className="border-t border-line">
              <th scope="row" className="py-2 text-left font-normal">
                {s.label}
              </th>
              <td className="py-2 pr-4" aria-hidden="true">
                <div className="h-2 rounded bg-brand-100">
                  <div
                    className="h-2 rounded bg-brand-600"
                    style={{ width: `${String((s.count / max) * 100)}%` }}
                  />
                </div>
              </td>
              <td className="py-2 text-right tabular-nums">{formatNumber(s.count)}</td>
              <td className="py-2 text-right tabular-nums">{formatHectares(s.area_ha)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}
