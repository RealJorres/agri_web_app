import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import type { Capability } from '@/lib/auth/context'
import { fakeAuth, fakeUser, jsonResponse, mockApi, page, renderPage } from '@/test/utils'

import NewEntryPage from './NewEntryPage'

const ROUND = '11111111-1111-4111-8111-111111111111'
const CROP = '22222222-2222-4222-8222-222222222222'
const STAGE = '33333333-3333-4333-8333-333333333333'
const TOWN = '44444444-4444-4444-8444-444444444444'
const BRGY = '55555555-5555-4555-8555-555555555555'
const RECORD = '66666666-6666-4666-8666-666666666666'
const FARMER = '77777777-7777-4777-8777-777777777777'

const saved = { id: RECORD, farmer: { id: FARMER, display_name: 'Rosa Sample1' } }
const routes = {
  'GET /api/v1/survey-rounds': page([
    { id: ROUND, name: 'Sample round', commodity: CROP, commodity_name: 'Sample crop' },
  ]),
  [`GET /api/v1/commodities/${CROP}/stages`]: [{ id: STAGE, code: 'S', label: 'Seedling' }],
  'GET /api/v1/varieties': [],
  'GET /api/v1/material-sources': [],
  'GET /api/v1/municipalities': [{ id: TOWN, name: 'Sample Town' }],
  'GET /api/v1/barangays': [{ id: BRGY, name: 'Synthetic Brgy', is_verified: true }],
  'GET /api/v1/farmers/duplicates': [],
  'POST /api/v1/inventory-entries': () => jsonResponse(201, saved),
  [`POST /api/v1/inventory-records/${RECORD}/submit`]: { ...saved, status: 'submitted' },
}

const as = (capabilities: Capability[]) => ({
  route: '/inventory/entry',
  auth: fakeAuth({ user: fakeUser({ capabilities }) }),
})
const ENCODER: Capability[] = ['view_records', 'edit_records', 'submit']

async function fillRow() {
  const user = userEvent.setup()
  await user.type(await screen.findByLabelText(/Last name/), 'Sample1')
  await user.selectOptions(await screen.findByLabelText(/Municipality/), TOWN)
  await user.selectOptions(await screen.findByLabelText(/Home barangay/), BRGY)
  await user.click(screen.getByRole('checkbox', { name: /read this notice/ }))
  await user.type(await screen.findByLabelText('Seedling'), '12')
  return user
}

// jsdom has no layout, so it has no scrolling either.
Element.prototype.scrollIntoView = vi.fn()

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('NewEntryPage', () => {
  it('sends the whole row as one request', async () => {
    const state = mockApi(routes)
    renderPage(<NewEntryPage />, as(ENCODER))
    const user = await fillRow()
    await user.click(screen.getByRole('button', { name: 'Save draft' }))

    await waitFor(() => {
      expect(state.calls.some((c) => c.method === 'POST')).toBe(true)
    })
    const posts = state.calls.filter((c) => c.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]?.body).toMatchObject({
      survey_round: ROUND,
      new_farmer: { last_name: 'Sample1', home_barangay: BRGY, consent_given: true },
      counts: [{ growth_stage: STAGE, count: 12 }],
    })
  })

  it('submits after saving when asked', async () => {
    const state = mockApi(routes)
    renderPage(<NewEntryPage />, as(ENCODER))
    const user = await fillRow()
    await user.click(screen.getByRole('button', { name: 'Save and submit' }))

    await waitFor(() => {
      expect(state.calls.map((c) => c.url.pathname)).toContain(
        `/api/v1/inventory-records/${RECORD}/submit`,
      )
    })
  })

  it('keeps the round and place, and clears the farmer, for the next entry', async () => {
    mockApi(routes)
    renderPage(<NewEntryPage />, as(ENCODER))
    const user = await fillRow()
    await user.click(screen.getByRole('checkbox', { name: /Enter another/ }))
    await user.click(screen.getByRole('button', { name: 'Save draft' }))

    expect(await screen.findByRole('link', { name: 'Open record' })).toHaveAttribute(
      'href',
      `/inventory/${RECORD}`,
    )
    expect(screen.getByLabelText(/Last name/)).toHaveValue('')
    expect(screen.getByLabelText(/Survey round/)).toHaveValue(ROUND)
    expect(screen.getByLabelText(/Municipality/)).toHaveValue(TOWN)
    expect(screen.getByRole('checkbox', { name: /read this notice/ })).not.toBeChecked()
  })

  it('asks for the name, place, consent and a count before sending', async () => {
    const state = mockApi(routes)
    renderPage(<NewEntryPage />, as(ENCODER))
    await screen.findByLabelText('Seedling')
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }))

    expect(await screen.findByText('Enter the farmer’s name.')).toBeInTheDocument()
    expect(screen.getByText('Choose the home barangay.')).toBeInTheDocument()
    expect(screen.getByText(/record consent/)).toBeInTheDocument()
    expect(screen.getByText(/at least one count/)).toBeInTheDocument()
    expect(state.calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('shows the server’s reason when the entry is refused', async () => {
    mockApi({
      ...routes,
      'POST /api/v1/inventory-entries': () =>
        jsonResponse(409, {
          code: 'duplicate_record',
          message: 'This crop stand already has a record in this round.',
          fields: { crop_stand: ['Already recorded in this round.'] },
        }),
    })
    renderPage(<NewEntryPage />, as(ENCODER))
    const user = await fillRow()
    await user.click(screen.getByRole('button', { name: 'Save draft' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('already has a record')
  })

  it('offers no submit without that permission', async () => {
    mockApi(routes)
    renderPage(<NewEntryPage />, as(['view_records', 'edit_records']))
    await screen.findByLabelText('Seedling')
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save and submit' })).not.toBeInTheDocument()
  })

  it('has no detectable accessibility violations', async () => {
    mockApi(routes)
    const { container } = renderPage(<NewEntryPage />, as(ENCODER))
    await screen.findByLabelText('Seedling')
    expect(await axe(container)).toHaveNoViolations()
  })
})
