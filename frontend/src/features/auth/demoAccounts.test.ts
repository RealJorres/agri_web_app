import { describe, expect, it } from 'vitest'

import { parseDemoAccounts } from './demoAccounts'

const ONE = { role: 'Viewer', email: 'viewer@example.test', password: 'synthetic-only' }

describe('parseDemoAccounts', () => {
  it('reads a list of accounts', () => {
    expect(parseDemoAccounts(JSON.stringify([ONE]))).toEqual([ONE])
  })

  it.each([undefined, '', '   ', 'not json', '{}', '[{"role":"Viewer"}]', 5])(
    'shows nothing for %j, so the panel is off unless set properly',
    (raw) => {
      expect(parseDemoAccounts(raw)).toEqual([])
    },
  )
})
