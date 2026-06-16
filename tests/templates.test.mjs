/**
 * Contract tests for `client.templates.preview`.
 *
 * Mirrors the in-process `fetch` mock used by admin-client.test.mjs.
 * Run with:
 *
 *   node --test tests/templates.test.mjs
 *
 * (assumes `pnpm build` has produced `dist/index.js`).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { Daguito, DaguitoError } from '../dist/index.js'

function makeFetchMock(responder) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ method, url, body })
    return responder({ method, url, body, headers: init.headers })
  }
  return { fetchImpl, calls }
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function build(responder) {
  const { fetchImpl, calls } = makeFetchMock(responder)
  const client = new Daguito({
    apiUrl: 'https://api.example.com',
    apiKey: 'dgsk_acc_test',
    fetchImpl,
  })
  return { client, calls }
}

function okPreviewResult() {
  return {
    template_schema: {
      name: 'SOAP_27',
      schema: { type: 'object', properties: { motivo: { type: 'string' } } },
    },
    field_names: ['motivo', 'alergias'],
    field_count: 2,
    fields_detail: [
      { name: 'motivo', description: 'razón de la consulta', type: 'string' },
      {
        name: 'severidad',
        description: 'severidad reportada',
        type: 'enum',
        enum_values: ['leve', 'moderada', 'grave'],
      },
    ],
    example: {
      transcript: 'Doctor, me duele la cabeza',
      transcript_origin: 'default',
      extracted: { motivo: 'cefalea', alergias: null },
      model: 'deepseek-v4-flash',
    },
    warnings: [
      { code: 'placeholder_empty', field: 'extra', message: 'placeholder has no body' },
    ],
    body_hash: 'sha256:abc123',
  }
}

test('templates.preview posts JSON and parses the response', async () => {
  const { client, calls } = build(() => jsonResponse(200, okPreviewResult()))
  const result = await client.templates.preview({
    templateBody: '[[razón de la consulta]] [[alergias del paciente]]',
    vertical: 'medical',
    model: 'deepseek-v4-flash',
    forceRegenerate: true,
  })

  assert.equal(calls[0].method, 'POST')
  assert.match(calls[0].url, /\/v1\/templates\/preview$/)
  assert.deepEqual(calls[0].body, {
    template_body: '[[razón de la consulta]] [[alergias del paciente]]',
    vertical: 'medical',
    model: 'deepseek-v4-flash',
    force_regenerate: true,
  })

  assert.equal(result.fieldCount, 2)
  assert.deepEqual(result.fieldNames, ['motivo', 'alergias'])
  assert.equal(result.templateSchema.name, 'SOAP_27')
  assert.equal(result.fieldsDetail[1].type, 'enum')
  assert.deepEqual(result.fieldsDetail[1].enumValues, ['leve', 'moderada', 'grave'])
  assert.equal(result.example?.transcriptOrigin, 'default')
  assert.equal(result.example?.extracted?.motivo, 'cefalea')
  assert.equal(result.warnings[0].code, 'placeholder_empty')
  assert.equal(result.bodyHash, 'sha256:abc123')
})

test('templates.preview omits optional fields when not provided', async () => {
  const { client, calls } = build(() => jsonResponse(200, okPreviewResult()))
  await client.templates.preview({ templateBody: '[[motivo]]' })
  assert.deepEqual(calls[0].body, { template_body: '[[motivo]]' })
})

test('templates.preview rejects empty templateBody before HTTP', async () => {
  const { client, calls } = build(() => jsonResponse(200, okPreviewResult()))
  await assert.rejects(
    client.templates.preview({ templateBody: '' }),
    (err) => err instanceof DaguitoError,
  )
  assert.equal(calls.length, 0)
})

test('templates.preview surfaces 400 as DaguitoError', async () => {
  const { client } = build(() => jsonResponse(400, { error: 'template_body required' }))
  await assert.rejects(
    client.templates.preview({ templateBody: '[[a]]' }),
    (err) =>
      err instanceof DaguitoError &&
      err.status === 400 &&
      err.message.includes('template_body required'),
  )
})

test('templates.preview handles null example + missing warnings', async () => {
  const { client } = build(() =>
    jsonResponse(200, {
      template_schema: { name: 'X', schema: {} },
      field_names: [],
      field_count: 0,
      fields_detail: [],
      example: null,
      body_hash: 'sha256:empty',
    }),
  )
  const result = await client.templates.preview({ templateBody: 'no placeholders' })
  assert.equal(result.example, null)
  assert.deepEqual(result.warnings, [])
  assert.equal(result.bodyHash, 'sha256:empty')
})
