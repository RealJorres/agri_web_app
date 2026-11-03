import type { ErrorRequestHandler, RequestHandler } from 'express'
import { ZodError } from 'zod'

import { DomainError, notFound, type ErrorBody, type ErrorFields } from '../lib/errors.js'
import { logger, safeErrorDetails } from '../lib/logger.js'

const NON_FIELD_ERRORS = 'non_field_errors'

function fieldsFromZod(error: ZodError): ErrorFields {
  const fields: ErrorFields = {}
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.') || NON_FIELD_ERRORS
    ;(fields[key] ??= []).push(issue.message)
  }
  return fields
}

/** Errors raised by Express and its body parser carry a 4xx status and sometimes a type. */
function clientErrorFrom(error: unknown): { status: number; type: string | undefined } | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const { status, type } = error as { status?: unknown; type?: unknown }
  if (typeof status !== 'number' || status < 400 || status >= 500) return undefined
  return { status, type: typeof type === 'string' ? type : undefined }
}

function toResponse(error: unknown): { status: number; body: ErrorBody } {
  if (error instanceof DomainError) {
    const { code, message, fields, status } = error
    return { status, body: { code, message, fields } }
  }
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        code: 'validation_error',
        message: 'Some fields are invalid.',
        fields: fieldsFromZod(error),
      },
    }
  }
  const client = clientErrorFrom(error)
  if (client?.type === 'entity.parse.failed') {
    return {
      status: 400,
      body: { code: 'parse_error', message: 'The request body is not valid JSON.', fields: {} },
    }
  }
  if (client?.type === 'entity.too.large') {
    return {
      status: 413,
      body: { code: 'payload_too_large', message: 'The request body is too large.', fields: {} },
    }
  }
  if (client) {
    return {
      status: client.status,
      body: { code: 'bad_request', message: 'The request could not be processed.', fields: {} },
    }
  }
  return {
    status: 500,
    body: { code: 'server_error', message: 'Something went wrong on the server.', fields: {} },
  }
}

export const unmatchedRoute: RequestHandler = (_req, _res, next) => {
  next(notFound())
}

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(error)
    return
  }
  const { status, body } = toResponse(error)
  if (status >= 500) logger.error('request.failed', { status, ...safeErrorDetails(error) })
  res.status(status).json(body)
}
