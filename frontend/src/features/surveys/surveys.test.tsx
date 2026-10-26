import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { Schemas } from '@/lib/api/client'
import { fakeAuth, fakeUser, mockApi, page, renderPage } from '@/test/utils'

import InventoryEntryPage from './InventoryEntryPage'
import { WorkflowActions } from './WorkflowActions'

const STAGES = [
  { id: 's1', code: 'SEEDLING', label: 'Seedling', sort_order: 1, is_bearing: false },
  { id: 's2', code: 'VEGETATIVE', label: 'Vegetative', sort_order: 2, is_bearing: false },
  { id: 's3', code: 'FLOWERING', label: 'Flowering', sort_order: 3, is_bearing: false },
  { id: 's4', code: 'FRUITING', label: 'Fruiting', sort_order: 4, is_bearing: true },
]
const STAND = {
  id: 'cs1',
  farm: 'farm1',
  commodity: { id: 'cacao', code: 'CACAO', name: 'Cacao' },
  spacing_m: null,
  attributes: {},
  plantings: [],
}
const ROUND = {
  id: 'r1',
  commodity: 'cacao',
  commodity_name: 'Cacao',
  name: 'Cacao 2026',
  as_of_date: '2026-06-30',
  deadline: null,
  status: 'open',
  is_historical: false,
  closed_at: null,
}

function record(overrides: Partial<Schemas['InventoryRecord']> = {}): Schemas['InventoryRecord'] {
  return {
    id: 'rec1',
    survey_round: { id: 'r1', name: 'Cacao 2026' },
    crop_stand: { id: 'cs1', commodity: 'CACAO', commodity_name: 'Cacao' },
    farm: { id: 'farm1', barangay: 'Synthetic Tabionan', municipality: 'Gasan' },
    farmer: { id: 'f1', display_name: 'Juan Sample' },
    status: 'submitted',
    version: 1,
    counts: [
      {
        growth_stage: { id: 's4', code: 'FRUITING', label: 'Fruiting', sort_order: 4 },
        count: 40,
        area_ha: null,
      },
    ],
    total: 40,
    remarks: '',
    flags: {
      warnings: [
        { code: 'outlier', message: 'Total 10,500 is more than 5x the municipal median.' },
      ],
    },
    submitted_at: '2026-06-01T00:00:00Z',
    validated_at: null,
    approved_at: null,
    updated_at: '2026-06-01T00:00:00Z',
    allowed_actions: ['edit', 'validate', 'return'],
    ...overrides,
  }
}

describe('InventoryEntryPage', () => {
  it('builds stage inputs from the commodity configuration and saves a draft', async () => {
    const api = mockApi({
      'GET /api/v1/crop-stands/cs1': STAND,
      'GET /api/v1/commodities/cacao/stages': STAGES,
      'GET /api/v1/survey-rounds': page([ROUND]),
      'POST /api/v1/inventory-records': record({
        status: 'draft',
        allowed_actions: ['edit', 'submit'],
      }),
    })
    renderPage(<InventoryEntryPage />, {
      route: '/inventory/new?crop_stand=cs1',
      path: '/inventory/new',
    })

    for (const stage of STAGES) {
      expect(await screen.findByLabelText(stage.label)).toBeInTheDocument()
    }
    await userEvent.type(screen.getByLabelText('Fruiting'), '12x')
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }))
    expect(await screen.findByText('Whole number, 0 or more.')).toBeInTheDocument()

    await userEvent.clear(screen.getByLabelText('Fruiting'))
    await userEvent.type(screen.getByLabelText('Fruiting'), '120')
    await userEvent.type(screen.getByLabelText('Seedling'), '5')
    expect(screen.getByText('125')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }))

    await waitFor(() => {
      expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
        survey_round: 'r1',
        crop_stand: 'cs1',
        counts: [
          { growth_stage: 's1', count: 5 },
          { growth_stage: 's4', count: 120 },
        ],
        remarks: '',
      })
    })
  })

  it('requires a count or a remark', async () => {
    mockApi({
      'GET /api/v1/crop-stands/cs1': STAND,
      'GET /api/v1/commodities/cacao/stages': STAGES,
      'GET /api/v1/survey-rounds': page([ROUND]),
    })
    renderPage(<InventoryEntryPage />, {
      route: '/inventory/new?crop_stand=cs1',
      path: '/inventory/new',
    })

    await userEvent.click(await screen.findByRole('button', { name: 'Save draft' }))

    expect(await screen.findByText(/Enter at least one count/)).toBeInTheDocument()
  })
})

describe('WorkflowActions', () => {
  it('shows only the actions the API allows and requires a comment to return', async () => {
    const api = mockApi({
      'POST /api/v1/inventory-records/rec1/return': record({
        status: 'draft',
        allowed_actions: [],
      }),
    })
    renderPage(<WorkflowActions record={record()} />)

    expect(screen.getByRole('button', { name: 'Validate' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Return for correction' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Please explain why')
    expect(api.calls).toHaveLength(0)

    await userEvent.type(screen.getByLabelText('Comment'), 'Recount the seedlings')
    await userEvent.click(screen.getByRole('button', { name: 'Return for correction' }))

    await waitFor(() => {
      expect(api.calls[0]?.body).toEqual({ comment: 'Recount the seedlings' })
    })
    expect(await screen.findByText('Record returned to the encoder.')).toBeInTheDocument()
  })

  it('renders nothing when no actions are allowed', () => {
    renderPage(<WorkflowActions record={record({ allowed_actions: ['edit'] })} />, {
      auth: fakeAuth({ user: fakeUser({ capabilities: ['view_records'] }) }),
    })

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Comment')).not.toBeInTheDocument()
  })
})
