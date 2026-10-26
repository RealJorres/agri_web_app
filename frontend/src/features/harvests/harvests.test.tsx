import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { Capability } from '@/lib/auth/context'
import { fakeAuth, fakeUser, mockApi, renderPage } from '@/test/utils'

import type { Harvest } from './api'
import { HarvestList } from './HarvestList'
import { HarvestSummaryCard } from './HarvestSummaryCard'
import { harvestSchema, toBody, toValues } from './schema'

const UNDATED: Harvest = {
  id: 'h1',
  crop_stand: 'cs1',
  harvest_date: null,
  date_estimated: true,
  quantity: '8.000',
  unit: 'kg',
  product_form: 'unknown',
  price_per_unit: null,
  buyer: '',
  raw_text: '8 kilos harvest',
  created_at: '2026-01-01T00:00:00Z',
}

const as = (capabilities: Capability[]) => ({
  auth: fakeAuth({ user: fakeUser({ capabilities }) }),
})

describe('harvest form rules', () => {
  it('marks a harvest without a date as estimated', () => {
    const values = { ...toValues(), quantity: '2.5' }
    expect(harvestSchema.safeParse(values).success).toBe(true)
    expect(toBody(values)).toMatchObject({ harvest_date: null, date_estimated: true })
    expect(toBody({ ...values, harvest_date: '2025-03-01' }).date_estimated).toBe(false)
  })

  it('rejects zero, negative and future values', () => {
    const base = toValues()
    expect(harvestSchema.safeParse({ ...base, quantity: '0' }).success).toBe(false)
    expect(harvestSchema.safeParse({ ...base, quantity: '-1' }).success).toBe(false)
    expect(
      harvestSchema.safeParse({ ...base, quantity: '1', harvest_date: '2999-01-01' }).success,
    ).toBe(false)
  })
})

describe('HarvestList', () => {
  it('shows reported harvests and adds one', async () => {
    const api = mockApi({
      'GET /api/v1/crop-stands/cs1/harvests': [UNDATED],
      'POST /api/v1/crop-stands/cs1/harvests': { ...UNDATED, id: 'h2' },
    })
    renderPage(<HarvestList standId="cs1" />, as(['view_records', 'edit_records']))

    expect(await screen.findByText('Date estimated')).toBeInTheDocument()
    expect(screen.getByText(/8 kilos harvest/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Add harvest' }))
    await userEvent.type(screen.getByLabelText(/Quantity/), '4.5')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const post = api.calls.find((c) => c.method === 'POST')
      expect(post?.body).toMatchObject({
        quantity: '4.5',
        unit: 'kg',
        product_form: 'dried_beans',
        harvest_date: null,
        date_estimated: true,
      })
    })
  })

  it('is read-only without edit_records', async () => {
    mockApi({ 'GET /api/v1/crop-stands/cs1/harvests': [UNDATED] })
    renderPage(<HarvestList standId="cs1" />, as(['view_records']))
    expect(await screen.findByText('Date estimated')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add harvest' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Delete harvest/ })).not.toBeInTheDocument()
  })
})

describe('HarvestSummaryCard', () => {
  it('keeps units apart and says how many undated harvests a year leaves out', async () => {
    mockApi({
      'GET /api/v1/analytics/harvests': (url: URL) => ({
        year: url.searchParams.get('year') ? 2025 : null,
        years: [2024, 2025],
        undated_excluded: url.searchParams.get('year') ? 3 : 0,
        rows: [
          {
            municipality_id: 'm1',
            municipality: 'Gasan',
            harvests: 4,
            farmers: 2,
            kg: { wet_beans: '20.000', dried_beans: '6.000', pods: '0', unknown: '8.000' },
            sacks: '1.000',
            other_entries: 0,
            estimated_dates: 1,
          },
        ],
      }),
    })
    renderPage(<HarvestSummaryCard />)
    expect(await screen.findByRole('rowheader', { name: 'Gasan' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Sacks' })).toBeInTheDocument()
    expect(screen.queryByText(/without a date/)).not.toBeInTheDocument()

    await userEvent.selectOptions(screen.getByLabelText('Year'), '2025')
    expect(await screen.findByText(/3 harvests without a date/)).toBeInTheDocument()
  })
})
