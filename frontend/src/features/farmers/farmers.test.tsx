import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import { jsonResponse, mockApi, page, renderPage } from '@/test/utils'

import FarmersPage from './FarmersPage'
import { FarmerForm } from './FarmerFormPage'

const GASAN = { id: 'm-gasan', name: 'Gasan', psgc_code: null }
const BRGY = {
  id: 'b-1',
  name: 'Synthetic Tabionan',
  psgc_code: null,
  municipality: 'm-gasan',
  is_verified: true,
}

function farmer(id: string, last: string) {
  return {
    id,
    display_name: `Juan ${last}`,
    first_name: 'Juan',
    middle_name: '',
    last_name: last,
    suffix: '',
    full_name_raw: '',
    sex: '',
    birth_year: null,
    rsbsa_no: null,
    contact_no: '',
    home_barangay: { id: BRGY.id, name: BRGY.name },
    municipality: { id: GASAN.id, name: GASAN.name },
    status: 'active',
    has_consent: true,
    consent_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

describe('FarmersPage', () => {
  it('lists farmers from the API and keeps search in the URL', async () => {
    const api = mockApi({
      'GET /api/v1/farmers': (url) =>
        url.searchParams.get('q') === 'sampleone'
          ? page([farmer('f1', 'Sampleone')])
          : page([farmer('f1', 'Sampleone'), farmer('f2', 'Sampletwo')]),
      'GET /api/v1/municipalities': [GASAN],
      'GET /api/v1/barangays': [BRGY],
    })
    renderPage(<FarmersPage />, { route: '/farmers?page=1' })

    expect(await screen.findByRole('link', { name: 'Juan Sampletwo' })).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('Search'), 'sampleone')

    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Juan Sampletwo' })).not.toBeInTheDocument()
    })
    const last = api.calls.filter((c) => c.url.pathname === '/api/v1/farmers').at(-1)
    expect(last?.url.searchParams.get('q')).toBe('sampleone')
  })

  it('sends sorting to the server', async () => {
    const api = mockApi({
      'GET /api/v1/farmers': page([farmer('f1', 'Sampleone')]),
      'GET /api/v1/municipalities': [GASAN],
      'GET /api/v1/barangays': [],
    })
    renderPage(<FarmersPage />, { route: '/farmers' })
    await screen.findByRole('link', { name: 'Juan Sampleone' })

    await userEvent.click(screen.getByRole('button', { name: /Name/ }))

    await waitFor(() => {
      const last = api.calls.filter((c) => c.url.pathname === '/api/v1/farmers').at(-1)
      expect(last?.url.searchParams.get('ordering')).toBe('last_name')
    })
  })

  it('is accessible', async () => {
    mockApi({
      'GET /api/v1/farmers': page([farmer('f1', 'Sampleone')]),
      'GET /api/v1/municipalities': [GASAN],
      'GET /api/v1/barangays': [],
    })
    const { container } = renderPage(<FarmersPage />, { route: '/farmers' })
    await screen.findByRole('link', { name: 'Juan Sampleone' })

    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('FarmerForm', () => {
  const reference = {
    'GET /api/v1/municipalities': [GASAN],
    'GET /api/v1/barangays': [BRGY],
  }

  it('requires a name, a barangay and recorded consent', async () => {
    mockApi({ ...reference, 'GET /api/v1/farmers/duplicates': [] })
    renderPage(<FarmerForm />)

    await userEvent.click(screen.getByRole('button', { name: 'Register farmer' }))

    expect(await screen.findByText('Enter the farmer’s name.')).toBeInTheDocument()
    expect(screen.getByText('Choose the municipality.')).toBeInTheDocument()
    expect(screen.getByText(/record their consent/)).toBeInTheDocument()
  })

  it('warns about likely duplicates while typing', async () => {
    mockApi({
      ...reference,
      'GET /api/v1/farmers/duplicates': [
        {
          id: 'dup-1',
          display_name: 'Maria Luisa Samplereyes',
          home_barangay: BRGY.name,
          municipality: 'Gasan',
          similarity: 1,
          reason: 'name',
        },
      ],
    })
    renderPage(<FarmerForm />)

    await userEvent.type(screen.getByLabelText('First name'), 'Ma. Luisa')
    await userEvent.type(screen.getByLabelText(/Last name/), 'Samplereyes')

    expect(await screen.findByText('This farmer may already be registered')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Maria Luisa Samplereyes' })).toHaveAttribute(
      'href',
      '/farmers/dup-1',
    )
    expect(screen.getByText(/100% name match/)).toBeInTheDocument()
  })

  it('submits and maps server field errors back onto the form', async () => {
    const api = mockApi({
      ...reference,
      'GET /api/v1/farmers/duplicates': [],
      'POST /api/v1/farmers': jsonResponse(409, {
        code: 'duplicate_rsbsa',
        message: 'Another farmer already has this RSBSA number.',
        fields: { rsbsa_no: ['Already registered to another farmer.'] },
      }),
    })
    renderPage(<FarmerForm />)

    await userEvent.type(screen.getByLabelText(/Last name/), 'Sampletest')
    await userEvent.type(screen.getByLabelText('RSBSA no.'), 'R-1')
    await userEvent.selectOptions(screen.getByLabelText(/Municipality/), GASAN.id)
    await screen.findByRole('option', { name: BRGY.name })
    await userEvent.selectOptions(screen.getByLabelText(/Home barangay/), BRGY.id)
    await userEvent.click(screen.getByLabelText(/I read this notice/))
    await userEvent.click(screen.getByRole('button', { name: 'Register farmer' }))

    expect(await screen.findByText('Already registered to another farmer.')).toBeInTheDocument()
    const post = api.calls.find((c) => c.method === 'POST')
    expect(post?.body).toMatchObject({
      last_name: 'Sampletest',
      rsbsa_no: 'R-1',
      home_barangay: BRGY.id,
      consent_given: true,
    })
  })
})
