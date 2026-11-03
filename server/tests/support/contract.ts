/** Checks responses against frontend/openapi.json, the maintained API contract (ADR-0019). */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Ajv } from 'ajv'

interface OpenApi {
  paths: Record<string, Record<string, Operation>>
  components: { schemas: Record<string, unknown> }
}

interface Operation {
  responses: Record<string, { content?: Record<string, { schema: unknown }> }>
}

const CONTRACT_PATH = join(import.meta.dirname, '..', '..', '..', 'frontend', 'openapi.json')
const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as OpenApi

/**
 * Tightens a contract schema so that extra or missing keys fail too. The serializers that produced
 * the contract always sent every declared field, so all of them are required here.
 */
function closed(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(closed)
  if (typeof schema !== 'object' || schema === null) return schema
  const source = schema as Record<string, unknown>
  const { allOf } = source
  if (Array.isArray(allOf) && allOf.length === 1) return closed(allOf[0])
  const result = Object.fromEntries(
    Object.entries(source).map(([key, value]) => [key, closed(value)]),
  )
  if (source.properties !== undefined) {
    result.additionalProperties = false
    result.required = Object.keys(source.properties as object)
  }
  return result
}

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  formats: {
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
    decimal: /^-?\d+(\.\d+)?$/u,
  },
})

/** Closes a schema and points its references into the registered contract document. */
function localRefs(schema: unknown): unknown {
  return JSON.parse(
    JSON.stringify(closed(schema)).replaceAll('"#/components', '"contract#/components'),
  )
}

ajv.addSchema({ $id: 'contract', components: localRefs(contract.components) }, 'contract')

/** Paths in the contract, with Express-style parameters. */
export function contractRoutes(): Set<string> {
  const routes = new Set<string>()
  for (const [path, operations] of Object.entries(contract.paths)) {
    if (!path.startsWith('/api/v1')) continue
    const express = path.slice('/api/v1'.length).replace(/\{(\w+)\}/gu, ':$1')
    for (const method of Object.keys(operations)) routes.add(`${method.toUpperCase()} ${express}`)
  }
  return routes
}

/** The ways a response differs from the contract. Empty when it matches. */
export function contractProblems(
  path: string,
  method: string,
  status: number,
  body: unknown,
): string[] {
  const operation = contract.paths[path]?.[method]
  if (!operation) return [`${method} ${path} is not in the contract`]
  const response = operation.responses[String(status)]
  if (!response) return [`${method} ${path} does not declare status ${String(status)}`]
  const schema = response.content?.['application/json']?.schema
  if (schema === undefined) return []
  const validate = ajv.compile(localRefs(schema) as object)
  if (validate(body)) return []
  return (validate.errors ?? []).map(
    (error) => `${error.instancePath || '/'} ${error.message ?? ''}`,
  )
}
