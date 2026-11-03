import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { fakeAuth, fakeUser, mockApi, page, renderPage } from '@/test/utils'

import MapPage from './MapPage'

// WebGL is not available under jsdom; the map itself is checked in a browser.
const mapProps = vi.hoisted(() => ({ latest: null as Record<string, unknown> | null }))
vi.mock('./ChoroplethMap', () => ({
  ChoroplethMap: (props: Record<string, unknown>) => {
    mapProps.latest = props
    return <div data-testid="map" />
  },
}))

const ROUND = {
  id: 'r1',
  name: 'Synthetic round',
  status: 'closed',
  is_historical: false,
  commodity: 'c1',
}
const ROW = {
  id: 'm1',
  name: 'Synthetic Town',
  trees: 1200,
  area_ha: '1.92',
  farmers: 3,
  records: 3,
  bearing_share: 0.5,
  stages: {},
}
const POINT = {
  id: 'f1',
  farmer: 'p1',
  lon: 121.9,
  lat: 13.4,
  barangay: 'Synthetic Barangay',
  municipality: 'Synthetic Town',
}

const config = (municipality_boundaries: number) => ({
  tile_url: 'https://tiles.example.test/{z}/{x}/{y}.png',
  tile_attribution: 'Test tiles',
  center: [121.9, 13.4],
  zoom: 10,
  municipality_boundaries,
  barangay_boundaries: 0,
})

function routes(boundaries = 0) {
  return {
    'GET /api/v1/survey-rounds': page([ROUND]),
    'GET /api/v1/municipalities': [{ id: 'm1', name: 'Synthetic Town', psgc_code: null }],
    'GET /api/v1/map/config': config(boundaries),
    'GET /api/v1/map/boundaries': { type: 'FeatureCollection', features: [] },
    'GET /api/v1/analytics/rounds/r1/breakdown': [ROW],
    'GET /api/v1/farms/points': { results: [POINT], total_farms: 4, located: 1 },
  }
}

const viewer = () =>
  fakeAuth({ user: fakeUser({ roles: ['viewer'], capabilities: ['view_aggregates'] }) })

describe('MapPage', () => {
  beforeEach(() => {
    mapProps.latest = null
  })

  it('says boundaries are missing, and never asks for them, but still shows the figures', async () => {
    const api = mockApi(routes(0))

    renderPage(<MapPage />)

    expect(await screen.findByText(/boundaries have not been loaded/i)).toBeInTheDocument()
    expect(await screen.findByRole('rowheader', { name: 'Synthetic Town' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '1,200' })).toBeInTheDocument()
    expect(api.calls.some((c) => c.url.pathname === '/api/v1/map/boundaries')).toBe(false)
  })

  it('draws boundaries with a legend once they are loaded', async () => {
    const api = mockApi(routes(6))

    renderPage(<MapPage />)

    await screen.findByRole('list', { name: 'Legend' })
    expect(screen.queryByText(/boundaries have not been loaded/i)).not.toBeInTheDocument()
    expect(api.calls.some((c) => c.url.pathname === '/api/v1/map/boundaries')).toBe(true)
  })

  it('shows farm coverage to roles with personal-data access', async () => {
    mockApi(routes())

    renderPage(<MapPage />)

    expect(await screen.findByText(/1 of 4 farms have a location/)).toBeInTheDocument()
    await waitFor(() => expect(mapProps.latest?.points).toEqual([POINT]))
  })

  it('never requests farm points for a viewer', async () => {
    const api = mockApi(routes())

    renderPage(<MapPage />, { auth: viewer() })

    await screen.findByRole('rowheader', { name: 'Synthetic Town' })
    expect(api.calls.some((c) => c.url.pathname === '/api/v1/farms/points')).toBe(false)
    expect(screen.queryByLabelText(/show farm locations/i)).not.toBeInTheDocument()
    expect(mapProps.latest?.points).toEqual([])
  })

  it('hides points when switched off and keeps coordinates out of the URL', async () => {
    const api = mockApi(routes())
    const user = userEvent.setup()

    renderPage(<MapPage />)

    await user.click(await screen.findByLabelText(/show farm locations/i))

    expect(mapProps.latest?.points).toEqual([])
    const leaked = api.calls.filter((c) => /121\.9|13\.4/.test(c.url.href))
    expect(leaked).toEqual([])
  })

  it('links a chosen farm to the farmer without showing a name', async () => {
    mockApi(routes())

    renderPage(<MapPage />)
    await waitFor(() => expect(mapProps.latest?.points).toEqual([POINT]))

    const choose = mapProps.latest?.onPointClick as (id: string) => void
    await vi.waitFor(() => choose('f1'))

    const link = await screen.findByRole('link', { name: 'Open farmer' })
    expect(link).toHaveAttribute('href', '/farmers/p1')
    expect(screen.getByText(/Farm in Synthetic Barangay, Synthetic Town\./)).toBeInTheDocument()
  })

  it('describes an area outside the view without implying zero', async () => {
    mockApi(routes())

    renderPage(<MapPage />)
    await screen.findByRole('rowheader', { name: 'Synthetic Town' })

    await waitFor(() => {
      const describeArea = mapProps.latest?.describeArea as (id: string, name: string) => string
      expect(describeArea('m1', 'Synthetic Town')).toBe('Synthetic Town: 1,200 trees')
    })
    const describeArea = mapProps.latest?.describeArea as (id: string, name: string) => string
    expect(describeArea('other', 'Elsewhere')).toBe('Elsewhere: no official data in your view')
  })

  it('has no accessibility violations', async () => {
    mockApi(routes(6))

    const { container } = renderPage(<MapPage />)
    await screen.findByRole('rowheader', { name: 'Synthetic Town' })

    expect(await axe(container)).toHaveNoViolations()
  })
})
