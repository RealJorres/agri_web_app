import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { ApiError } from '@/lib/api/client'
import { fakeAuth, renderPage } from '@/test/utils'

import LoginPage from './LoginPage'

const anonymous = (login = vi.fn()) => fakeAuth({ status: 'anonymous', user: null, login })

describe('LoginPage', () => {
  it('validates before calling the API', async () => {
    const login = vi.fn()
    renderPage(<LoginPage />, { route: '/login', auth: anonymous(login) })

    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument()
    expect(screen.getByText('Enter your password.')).toBeInTheDocument()
    expect(screen.getByLabelText(/Email/)).toHaveAttribute('aria-invalid', 'true')
    expect(login).not.toHaveBeenCalled()
  })

  it('signs in with the entered credentials', async () => {
    const login = vi.fn().mockResolvedValue(undefined)
    renderPage(<LoginPage />, { route: '/login', auth: anonymous(login) })

    await userEvent.type(screen.getByLabelText(/Email/), 'encoder@example.test')
    await userEvent.type(screen.getByLabelText(/Password/), 'secret-passphrase')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(login).toHaveBeenCalledWith('encoder@example.test', 'secret-passphrase')
  })

  it('shows the server message (e.g. lockout)', async () => {
    const login = vi
      .fn()
      .mockRejectedValue(
        new ApiError(429, { code: 'locked_out', message: 'Too many failed sign-in attempts.' }),
      )
    renderPage(<LoginPage />, { route: '/login', auth: anonymous(login) })

    await userEvent.type(screen.getByLabelText(/Email/), 'encoder@example.test')
    await userEvent.type(screen.getByLabelText(/Password/), 'wrong')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many failed sign-in attempts.')
  })

  it('has no detectable accessibility violations', async () => {
    const { container } = renderPage(<LoginPage />, { route: '/login', auth: anonymous() })

    expect(await axe(container)).toHaveNoViolations()
  })
})
