export type ErrorFields = Record<string, string[]>

/** The API error contract: every error response body has this shape. */
export interface ErrorBody {
  code: string
  message: string
  fields: ErrorFields
}

/** A business-rule violation raised by a service. Rendered as {code, message, fields}. */
export class DomainError extends Error {
  readonly code: string
  readonly fields: ErrorFields
  readonly status: number

  constructor(code: string, message: string, fields: ErrorFields = {}, status = 400) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.fields = fields
    this.status = status
  }
}

/** Also used for objects outside the caller's scope, which must look the same as missing ones. */
export function notFound(): DomainError {
  return new DomainError('not_found', 'Not found.', {}, 404)
}
