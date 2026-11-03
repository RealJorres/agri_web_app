import { describe, expect, it } from 'vitest'

import { ApiError } from '@/lib/api/client'

import { errorMessage } from './forms'

describe('errorMessage', () => {
  it('adds field details to the main message', () => {
    const error = new ApiError(400, {
      code: 'invalid',
      message: 'Some fields are invalid.',
      fields: { name: ['Required.'] },
    })
    expect(errorMessage(error)).toBe('Some fields are invalid. Required.')
  })

  it('does not repeat a field message that matches the main one', () => {
    const message = 'This image is damaged.'
    const error = new ApiError(400, { code: 'invalid_logo', message, fields: { file: [message] } })
    expect(errorMessage(error)).toBe(message)
  })
})
