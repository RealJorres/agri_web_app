import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { DemoAccountList } from './DemoAccountList'

const ACCOUNTS = [
  { role: 'Role one', email: 'one@example.test', password: 'pass-one' },
  { role: 'Role two', email: 'two@example.test', password: 'pass-two' },
]
const SHOWN = ACCOUNTS.flatMap((account) => [account.role, account.email, account.password])

describe('DemoAccountList', () => {
  it('removes every account at once, and brings them all back', async () => {
    render(<DemoAccountList accounts={ACCOUNTS} onUse={vi.fn()} />)
    for (const value of SHOWN) expect(screen.getByText(value)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Hide all' }))
    for (const value of SHOWN) expect(screen.queryByText(value)).not.toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Use the/ })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Demo accounts' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Unhide all' }))
    for (const value of SHOWN) expect(screen.getByText(value)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hide all' })).toBeInTheDocument()
  })

  it('fills the form from an account', async () => {
    const onUse = vi.fn()
    render(<DemoAccountList accounts={ACCOUNTS} onUse={onUse} />)

    await userEvent.click(screen.getByRole('button', { name: 'Use the Role two account' }))

    expect(onUse).toHaveBeenCalledWith(ACCOUNTS[1])
  })

  it('has no detectable accessibility violations when hidden', async () => {
    const { container } = render(<DemoAccountList accounts={ACCOUNTS} onUse={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Hide all' }))

    expect(await axe(container)).toHaveNoViolations()
  })
})
