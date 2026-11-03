import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'vitest-axe'
import { describe, expect, it } from 'vitest'

import { fakeAuth, fakeUser, mockApi, page, renderPage } from '@/test/utils'

import CropDetailPage from './CropDetailPage'
import CropsPage from './CropsPage'
import ReportSettingsPage from './ReportSettingsPage'
import SourcesPage from './SourcesPage'
import UserDetailPage from './UserDetailPage'
import UsersPage from './UsersPage'

const PROGRAM = { id: 'p1', code: 'SYN', name: 'Synthetic program' }
const CROP = {
  id: 'c1',
  code: 'SYNCROP',
  name: 'Synthetic crop',
  program: PROGRAM,
  measure_type: 'trees',
  spacing_m: null,
  plants_per_ha: 400,
  attributes_schema: {},
  outlier_multiplier: '5.00',
  stages: [],
}
const USER = {
  id: 'u2',
  email: 'ana.sample1@example.test',
  first_name: 'Ana',
  last_name: 'Sample1',
  full_name: 'Ana Sample1',
  is_active: true,
  is_superuser: false,
  last_login_at: null,
  assignments: [
    {
      id: 'as1',
      role: 'viewer',
      role_label: 'Viewer',
      municipality: null,
      program: null,
      barangays: [],
    },
  ],
}

function fail(status: number, code: string, message: string, fields = {}) {
  return () =>
    new Response(JSON.stringify({ code, message, fields }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
}

function created(body: object) {
  return () =>
    new Response(JSON.stringify(body), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    })
}

/** Every dialog stays in the page while closed, so this finds the open one. */
function openDialog(): HTMLElement {
  const dialog = document.querySelector<HTMLElement>('dialog[open]')
  if (!dialog) throw new Error('No dialog is open.')
  return dialog
}

const noContent = () => new Response(null, { status: 204 })

describe('UsersPage', () => {
  it('lists accounts with their roles, and is accessible', async () => {
    mockApi({ 'GET /api/v1/admin/users': page([USER]) })
    const { container } = renderPage(<UsersPage />)
    expect(await screen.findByRole('link', { name: 'Ana Sample1' })).toBeInTheDocument()
    expect(screen.getByText('Viewer')).toBeInTheDocument()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('creates an account and shows a password refusal on the field', async () => {
    const api = mockApi({
      'GET /api/v1/admin/users': page([]),
      'POST /api/v1/admin/users': fail(400, 'invalid_password', 'The password is not acceptable.', {
        password: ['This password is too common.'],
      }),
    })
    const user = userEvent.setup()
    renderPage(<UsersPage />)
    await user.click(await screen.findByRole('button', { name: 'New user' }))
    await user.type(screen.getByLabelText(/Email/u), 'new.sample2@example.test')
    await user.type(screen.getByLabelText(/Starting password/u), 'password')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('This password is too common.')).toBeInTheDocument()
    expect(api.calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      email: 'new.sample2@example.test',
    })
  })
})

describe('UserDetailPage', () => {
  const route = { route: '/admin/users/u2', path: '/admin/users/:id' }

  it('adds a role', async () => {
    const api = mockApi({
      'GET /api/v1/admin/users/u2': USER,
      'GET /api/v1/municipalities': [{ id: 'm1', name: 'Gasan' }],
      'GET /api/v1/programs': [PROGRAM],
      'GET /api/v1/barangays': [],
      'POST /api/v1/admin/users/u2/assignments': created(USER),
    })
    const user = userEvent.setup()
    renderPage(<UserDetailPage />, route)
    await user.click(await screen.findByRole('button', { name: 'Add role' }))
    const dialog = openDialog()
    await user.selectOptions(within(dialog).getByLabelText(/Role/u), 'mao_validator')
    await within(dialog).findByRole('option', { name: 'Gasan', hidden: true })
    await user.selectOptions(within(dialog).getByLabelText('Municipality'), 'm1')
    await user.click(within(dialog).getByRole('button', { name: 'Add role', hidden: true }))
    await waitFor(() => {
      expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
        role: 'mao_validator',
        municipality: 'm1',
        program: null,
        barangays: [],
      })
    })
  })

  it('shows why the last administrator cannot lose the role', async () => {
    mockApi({
      'GET /api/v1/admin/users/u2': USER,
      'GET /api/v1/municipalities': [],
      'GET /api/v1/barangays': [],
      'DELETE /api/v1/admin/users/u2/assignments/as1': fail(
        409,
        'last_admin',
        'This would leave no active system administrator.',
      ),
    })
    const user = userEvent.setup()
    renderPage(<UserDetailPage />, route)
    await user.click(await screen.findByRole('button', { name: 'Remove Viewer' }))
    await user.click(screen.getByRole('button', { name: 'Remove role', hidden: true }))
    expect(await screen.findByRole('alert', { hidden: true })).toHaveTextContent(
      'no active system administrator',
    )
  })

  it('does not offer deactivating your own account', async () => {
    mockApi({
      'GET /api/v1/admin/users/u2': USER,
      'GET /api/v1/municipalities': [],
      'GET /api/v1/barangays': [],
    })
    renderPage(<UserDetailPage />, {
      ...route,
      auth: fakeAuth({ user: fakeUser({ id: 'u2' }) }),
    })
    expect(await screen.findByText(/cannot deactivate your own account/u)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Deactivate account' })).not.toBeInTheDocument()
  })

  it('deactivates someone else after asking', async () => {
    const api = mockApi({
      'GET /api/v1/admin/users/u2': USER,
      'GET /api/v1/municipalities': [],
      'GET /api/v1/barangays': [],
      'PATCH /api/v1/admin/users/u2': { ...USER, is_active: false },
    })
    const user = userEvent.setup()
    renderPage(<UserDetailPage />, route)
    await user.click(await screen.findByRole('button', { name: 'Deactivate account' }))
    expect(api.calls.some((c) => c.method === 'PATCH')).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Deactivate', hidden: true }))
    await waitFor(() => {
      expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ is_active: false })
    })
  })
})

describe('CropsPage', () => {
  it('flags a crop that has no stages, and creates a new one', async () => {
    const api = mockApi({
      'GET /api/v1/commodities': [CROP],
      'GET /api/v1/programs': [PROGRAM],
      'POST /api/v1/admin/commodities': created({ ...CROP, id: 'c2' }),
    })
    const user = userEvent.setup()
    renderPage(<CropsPage />, { route: '/admin/crops', path: '/admin/crops' })
    expect(await screen.findByText('Needs growth stages')).toBeInTheDocument()
    await screen.findByText('Synthetic program', { selector: 'span' })
    await user.click(screen.getByRole('button', { name: 'New crop' }))
    const dialog = openDialog()
    await user.selectOptions(within(dialog).getByLabelText(/^Program/u), 'p1')
    await user.type(within(dialog).getByLabelText(/^Name/u), 'Second crop')
    await user.type(within(dialog).getByLabelText(/^Code/u), 'second')
    await user.type(within(dialog).getByLabelText(/Plants per hectare/u), '625')
    await user.click(within(dialog).getByRole('button', { name: 'Create crop', hidden: true }))
    await waitFor(() => {
      expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
        program: 'p1',
        code: 'second',
        name: 'Second crop',
        measure_type: 'trees',
        plants_per_ha: 625,
      })
    })
    expect(await screen.findByText('other page')).toBeInTheDocument()
  })
})

describe('CropDetailPage', () => {
  const route = { route: '/admin/crops/c1', path: '/admin/crops/:id' }
  const base = {
    'GET /api/v1/commodities/c1': CROP,
    'GET /api/v1/programs': [PROGRAM],
    'GET /api/v1/admin/commodities/c1/stages': [],
    'GET /api/v1/admin/varieties': [],
  }

  it('locks the program and measure once the crop is in use', async () => {
    const api = mockApi({
      ...base,
      'GET /api/v1/admin/commodities/c1/usage': { crop_stands: 3, rounds: 1 },
      'PATCH /api/v1/admin/commodities/c1': CROP,
    })
    const user = userEvent.setup()
    renderPage(<CropDetailPage />, route)
    expect(await screen.findByText(/In use by 3 crop stands/u)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Program/u)).toBeDisabled()
    expect(screen.getByLabelText(/How it is measured/u)).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      const body = api.calls.find((c) => c.method === 'PATCH')?.body as object
      expect(body).toMatchObject({ name: 'Synthetic crop', plants_per_ha: 400 })
      expect(body).not.toHaveProperty('program')
      expect(body).not.toHaveProperty('measure_type')
    })
  })

  it('leaves the program open on an unused crop', async () => {
    mockApi({ ...base, 'GET /api/v1/admin/commodities/c1/usage': { crop_stands: 0, rounds: 0 } })
    renderPage(<CropDetailPage />, route)
    await waitFor(() => {
      expect(screen.getByLabelText(/^Program/u)).toBeEnabled()
    })
  })

  it('refuses attributes that are not JSON, without calling the server', async () => {
    const api = mockApi({
      ...base,
      'GET /api/v1/admin/commodities/c1/usage': { crop_stands: 0, rounds: 0 },
    })
    const user = userEvent.setup()
    renderPage(<CropDetailPage />, route)
    const box = await screen.findByLabelText(/Crop attributes/u)
    await user.clear(box)
    await user.type(box, 'not json')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('This is not valid JSON.')).toBeInTheDocument()
    expect(api.calls.some((c) => c.method === 'PATCH')).toBe(false)
  })

  it('adds a stage with its other spellings, in the next position', async () => {
    const api = mockApi({
      ...base,
      'GET /api/v1/admin/commodities/c1/usage': { crop_stands: 0, rounds: 0 },
      'GET /api/v1/admin/commodities/c1/stages': [
        {
          id: 's1',
          code: 'EARLY',
          label: 'Early',
          sort_order: 2,
          is_bearing: false,
          aliases: ['Young'],
        },
      ],
      'POST /api/v1/admin/commodities/c1/stages': created({}),
    })
    const user = userEvent.setup()
    renderPage(<CropDetailPage />, route)
    expect(await screen.findByText(/also: Young/u)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add stage' }))
    const dialog = openDialog()
    await user.type(within(dialog).getByLabelText(/^Name/u), 'Mature')
    await user.type(within(dialog).getByLabelText(/^Code/u), 'mature')
    await user.click(within(dialog).getByLabelText(/bears fruit/u))
    await user.type(within(dialog).getByLabelText(/Other spellings/u), 'Bearing{enter}  {enter}Old')
    await user.click(within(dialog).getByRole('button', { name: 'Save', hidden: true }))
    await waitFor(() => {
      expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
        code: 'mature',
        label: 'Mature',
        sort_order: 3,
        is_bearing: true,
        aliases: ['Bearing', 'Old'],
      })
    })
  })

  it('shows why a stage in use cannot be removed', async () => {
    mockApi({
      ...base,
      'GET /api/v1/admin/commodities/c1/usage': { crop_stands: 0, rounds: 0 },
      'GET /api/v1/admin/commodities/c1/stages': [
        { id: 's1', code: 'EARLY', label: 'Early', sort_order: 1, is_bearing: false, aliases: [] },
      ],
      'DELETE /api/v1/admin/stages/s1': fail(
        409,
        'in_use',
        'This stage is used by existing records.',
      ),
    })
    const user = userEvent.setup()
    renderPage(<CropDetailPage />, route)
    await user.click(await screen.findByRole('button', { name: 'Remove Early' }))
    await user.click(screen.getByRole('button', { name: 'Remove stage', hidden: true }))
    expect(await screen.findByRole('alert', { hidden: true })).toHaveTextContent('used by existing')
  })
})

describe('SourcesPage', () => {
  it('adds and removes sources', async () => {
    const api = mockApi({
      'GET /api/v1/admin/material-sources': [
        { id: 'ms1', code: 'OWN', name: 'Own produced', aliases: ['Self'] },
      ],
      'POST /api/v1/admin/material-sources': created({}),
      'DELETE /api/v1/admin/material-sources/ms1': noContent,
    })
    const user = userEvent.setup()
    const { container } = renderPage(<SourcesPage />)
    expect(await screen.findByText(/also: Self/u)).toBeInTheDocument()
    expect(await axe(container)).toHaveNoViolations()
    await user.click(screen.getByRole('button', { name: 'New source' }))
    const dialog = openDialog()
    await user.type(within(dialog).getByLabelText(/^Name/u), 'Regional office')
    await user.type(within(dialog).getByLabelText(/^Code/u), 'RO')
    await user.click(within(dialog).getByRole('button', { name: 'Save', hidden: true }))
    await waitFor(() => {
      expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
        code: 'RO',
        name: 'Regional office',
        aliases: [],
      })
    })
    await user.click(await screen.findByRole('button', { name: 'Remove Own produced' }))
    await user.click(screen.getByRole('button', { name: 'Remove source', hidden: true }))
    await waitFor(() => {
      expect(api.calls.some((c) => c.method === 'DELETE')).toBe(true)
    })
  })
})

describe('ReportSettingsPage', () => {
  const settings = {
    letterhead: 'Synthetic Office',
    program_line: 'SYNTHETIC PROGRAM',
    has_logo: false,
  }

  it('warns about signed reports and saves the letterhead', async () => {
    const api = mockApi({
      'GET /api/v1/admin/report-settings': settings,
      'GET /api/v1/admin/signatories': [],
      'PATCH /api/v1/admin/report-settings': settings,
    })
    const user = userEvent.setup()
    const { container } = renderPage(<ReportSettingsPage />)
    expect(await screen.findByText(/need signing again/u)).toBeInTheDocument()
    const box = await screen.findByLabelText(/^Letterhead/u)
    await user.type(box, '{enter}Second line')
    expect(await axe(container)).toHaveNoViolations()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        letterhead: 'Synthetic Office\nSecond line',
        program_line: 'SYNTHETIC PROGRAM',
      })
    })
  })

  it('shows a refused logo, and asks for a file first', async () => {
    mockApi({
      'GET /api/v1/admin/report-settings': settings,
      'GET /api/v1/admin/signatories': [],
      'POST /api/v1/admin/report-settings/logo': fail(
        400,
        'invalid_logo',
        'This image is damaged.',
      ),
    })
    const user = userEvent.setup()
    renderPage(<ReportSettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Upload logo' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose an image')
    const image = new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' })
    await user.upload(screen.getByLabelText(/Image \(PNG/u), image)
    await user.click(screen.getByRole('button', { name: 'Upload logo' }))
    expect(await screen.findByText('This image is damaged.')).toBeInTheDocument()
  })

  it('lists and adds signature blocks', async () => {
    const api = mockApi({
      'GET /api/v1/admin/report-settings': { ...settings, has_logo: true },
      'GET /api/v1/admin/signatories': [
        {
          id: 'si1',
          report_kind: 'summary',
          order: 1,
          caption: 'Prepared by:',
          name: 'Ana Sample1',
          title: 'Synthetic title',
        },
      ],
      'POST /api/v1/admin/signatories': created({}),
    })
    const user = userEvent.setup()
    renderPage(<ReportSettingsPage />)
    expect(await screen.findByText(/Ana Sample1, Synthetic title/u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove logo' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add' }))
    const dialog = openDialog()
    await user.selectOptions(within(dialog).getByLabelText(/^Report/u), 'municipal_list')
    await user.type(within(dialog).getByLabelText(/^Caption/u), 'Noted by:')
    await user.type(within(dialog).getByLabelText(/^Name/u), 'Ben Sample2')
    await user.click(within(dialog).getByRole('button', { name: 'Save', hidden: true }))
    await waitFor(() => {
      expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
        report_kind: 'municipal_list',
        order: 1,
        caption: 'Noted by:',
        name: 'Ben Sample2',
        title: '',
      })
    })
  })
})
