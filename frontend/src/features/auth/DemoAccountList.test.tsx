import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { DemoAccountList } from './DemoAccountList'

const ACCOUNTS = [
  { role: 'Role one', email: 'one@example.test', password: 'pass-one' },
  { role: 'Role two', email: 'two@example.test', password: 'pass-two' },
]
const CREDENTIALS = ACCOUNTS.flatMap((account) => [account.email, account.password])

describe('DemoAccountList', () => {
  it('hides every credential at once, and brings them all back', async () => {
    render(<DemoAccountList accounts={ACCOUNTS} onUse={vi.fn()} />)
    for (const value of CREDENTIALS) expect(screen.getByText(value)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Hide all' }))
    for (const value of CREDENTIALS) expect(screen.queryByText(value)).not.toBeInTheDocument()
    expect(screen.getByText('Role one')).toBeInTheDocument()
    expect(screen.getByText('Role two')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Unhide all' }))
    for (const value of CREDENTIALS) expect(screen.getByText(value)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hide all' })).toBeInTheDocument()
  })

  it('still fills the form while the credentials are hidden', async () => {
    const onUse = vi.fn()
    render(<DemoAccountList accounts={ACCOUNTS} onUse={onUse} />)

    await userEvent.click(screen.getByRole('button', { name: 'Hide all' }))
    await userEvent.click(screen.getByRole('button', { name: 'Use the Role two account' }))

    expect(onUse).toHaveBeenCalledWith(ACCOUNTS[1])
  })

  it('has no detectable accessibility violations when hidden', async () => {
    const { container } = render(<DemoAccountList accounts={ACCOUNTS} onUse={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Hide all' }))

    expect(await axe(container)).toHaveNoViolations()
  })
})
