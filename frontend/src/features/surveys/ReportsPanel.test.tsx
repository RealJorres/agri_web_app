import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { Capability } from '@/lib/auth/context'
import { fakeAuth, fakeUser, mockApi, renderPage } from '@/test/utils'

import { ReportsPanel } from './ReportsPanel'

const UNSIGNED = {
  state: 'unsigned',
  signed_by: null,
  signed_at: null,
  content_sha256: null,
  current_sha256: 'abc',
}
const TOWNS = [{ id: 'm1', name: 'Gasan' }]

const as = (capabilities: Capability[]) => ({
  auth: fakeAuth({ user: fakeUser({ capabilities }) }),
})

describe('ReportsPanel', () => {
  it('lets the provincial head sign a closed round', async () => {
    const api = mockApi({
      'GET /api/v1/reports/rounds/r1/sign-off': UNSIGNED,
      'POST /api/v1/reports/rounds/r1/sign-off': {
        ...UNSIGNED,
        state: 'signed',
        signed_by: 'Synthetic Head',
        signed_at: '2026-10-27T00:00:00Z',
      },
    })
    renderPage(
      <ReportsPanel roundId="r1" roundName="Cacao 2026" closed municipalities={TOWNS} />,
      as(['view_aggregates', 'export_personal_data', 'sign_reports']),
    )
    expect(await screen.findByText('Not signed')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Municipal farmer list' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Sign off summary' }))
    await userEvent.click(screen.getByRole('button', { name: 'Sign off' }))
    await waitFor(() => {
      expect(api.calls.some((c) => c.method === 'POST')).toBe(true)
    })
  })

  it('hides sign-off on an open round and farmer lists without the export capability', async () => {
    mockApi({ 'GET /api/v1/reports/rounds/r1/sign-off': UNSIGNED })
    renderPage(
      <ReportsPanel roundId="r1" roundName="Cacao 2026" closed={false} municipalities={TOWNS} />,
      as(['view_aggregates', 'sign_reports']),
    )
    expect(await screen.findByText('Not signed')).toBeInTheDocument()
    expect(screen.getByText(/reports are marked DRAFT/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign off summary' })).not.toBeInTheDocument()
    expect(screen.queryByText('Municipal farmer list')).not.toBeInTheDocument()
  })
})
