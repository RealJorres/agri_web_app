import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { fakeAuth, renderPage } from '@/test/utils'

import { AppShell } from './AppShell'

async function openDialog() {
  await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  return within(await screen.findByRole('dialog', { name: 'Sign out?' }))
}

describe('signing out', () => {
  it('asks first, and signs out only when confirmed', async () => {
    const logout = vi.fn().mockResolvedValue(undefined)
    renderPage(<AppShell />, { auth: fakeAuth({ logout }) })

    const dialog = await openDialog()
    expect(logout).not.toHaveBeenCalled()

    await userEvent.click(dialog.getByRole('button', { name: 'Sign out' }))
    expect(logout).toHaveBeenCalledOnce()
  })

  it('stays signed in on cancel', async () => {
    const logout = vi.fn()
    renderPage(<AppShell />, { auth: fakeAuth({ logout }) })

    const dialog = await openDialog()
    await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }))

    expect(logout).not.toHaveBeenCalled()
    expect(screen.queryByText(/haven’t saved/)).not.toBeInTheDocument()
  })

  it('has no detectable accessibility violations while asking', async () => {
    const { container } = renderPage(<AppShell />)
    await openDialog()

    expect(await axe(container)).toHaveNoViolations()
  })
})
