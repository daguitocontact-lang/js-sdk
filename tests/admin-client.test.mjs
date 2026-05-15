/**
 * Contract tests for the admin `Daguito` client.
 *
 * Uses a tiny in-process `fetch` mock — the client accepts a `fetchImpl`
 * override, so we drive every code path without a real HTTP stack. Built
 * on Node's `node:test`; run with:
 *
 *   node --test tests/admin-client.test.mjs
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
  return new Response(body === null ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function emptyResponse(status) {
  return new Response(null, { status })
}

function okAccountKey(overrides = {}) {
  return {
    id: 'ak_1',
    name: 'prod',
    key_prefix: 'dgsk_acc_abc12',
    monthly_budget_micro_usd: null,
    current_mtd_micro_usd: 0,
    created_at: '2026-05-14T00:00:00.000Z',
    last_used_at: null,
    revoked_at: null,
    ...overrides,
  }
}

function okPublicKey(overrides = {}) {
  return {
    id: 'pk_1',
    flow_id: 'flow_abc',
    name: 'browser',
    key_prefix: 'dgpk_flow_x9',
    allowed_origins: ['https://example.com'],
    monthly_budget_micro_usd: null,
    current_mtd_micro_usd: 0,
    created_at: '2026-05-14T00:00:00.000Z',
    last_used_at: null,
    revoked_at: null,
    ...overrides,
  }
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

test('accountKeys.list returns parsed AccountKey[]', async () => {
  const { client, calls } = build(() =>
    jsonResponse(200, { keys: [okAccountKey(), okAccountKey({ id: 'ak_2' })] }),
  )
  const keys = await client.accountKeys.list()
  assert.equal(keys.length, 2)
  assert.equal(keys[0].id, 'ak_1')
  assert.equal(keys[0].keyPrefix, 'dgsk_acc_abc12')
  assert.equal(calls[0].method, 'GET')
  assert.match(calls[0].url, /\/v1\/account\/api-keys$/)
})

test('accountKeys.create returns plaintext and posts JSON', async () => {
  const { client, calls } = build(() =>
    jsonResponse(201, { ...okAccountKey(), plaintext: 'dgsk_acc_FULL' }),
  )
  const created = await client.accountKeys.create({
    name: 'prod',
    monthlyBudgetMicroUsd: 5_000_000,
  })
  assert.equal(created.plaintext, 'dgsk_acc_FULL')
  assert.equal(created.id, 'ak_1')
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(calls[0].body, { name: 'prod', monthly_budget_micro_usd: 5_000_000 })
})

test('accountKeys.revoke handles 204', async () => {
  const { client, calls } = build(() => emptyResponse(204))
  await client.accountKeys.revoke('ak_1')
  assert.equal(calls[0].method, 'DELETE')
  assert.match(calls[0].url, /\/v1\/account\/api-keys\/ak_1$/)
})

test('accountKeys.setBudget refetches the full shape', async () => {
  const responses = [
    jsonResponse(200, { id: 'ak_1', monthly_budget_micro_usd: 1_000_000 }),
    jsonResponse(200, {
      keys: [okAccountKey({ monthly_budget_micro_usd: 1_000_000 })],
    }),
  ]
  const { client, calls } = build(() => responses.shift())
  const updated = await client.accountKeys.setBudget('ak_1', 1_000_000)
  assert.equal(updated.monthlyBudgetMicroUsd, 1_000_000)
  assert.equal(calls[0].method, 'PATCH')
  assert.equal(calls[1].method, 'GET')
})

test('accountKeys 401 maps to DaguitoError with status', async () => {
  const { client } = build(() => jsonResponse(401, { error: 'missing bearer' }))
  await assert.rejects(client.accountKeys.list(), (err) => {
    return err instanceof DaguitoError && err.status === 401 && err.message.includes('missing bearer')
  })
})

test('accountKeys 403 maps to DaguitoError with status', async () => {
  const { client } = build(() => jsonResponse(403, { error: 'not an admin' }))
  await assert.rejects(client.accountKeys.list(), (err) => {
    return err instanceof DaguitoError && err.status === 403
  })
})

test('publicKeys.list for flow', async () => {
  const { client, calls } = build(() => jsonResponse(200, { keys: [okPublicKey()] }))
  const keys = await client.publicKeys.list('flow_abc')
  assert.equal(keys.length, 1)
  assert.equal(keys[0].flowId, 'flow_abc')
  assert.deepEqual(keys[0].allowedOrigins, ['https://example.com'])
  assert.match(calls[0].url, /\/v1\/flows\/flow_abc\/public-keys$/)
})

test('publicKeys.create posts allowed_origins on the wire', async () => {
  const { client, calls } = build(() =>
    jsonResponse(201, { ...okPublicKey(), plaintext: 'dgpk_flow_FULL' }),
  )
  const created = await client.publicKeys.create('flow_abc', {
    name: 'browser',
    allowedOrigins: ['https://example.com'],
  })
  assert.equal(created.plaintext, 'dgpk_flow_FULL')
  assert.deepEqual(calls[0].body, {
    name: 'browser',
    allowed_origins: ['https://example.com'],
  })
})

test('publicKeys.revoke hits flow-scoped URL', async () => {
  const { client, calls } = build(() => emptyResponse(204))
  await client.publicKeys.revoke('flow_abc', 'pk_1')
  assert.equal(calls[0].method, 'DELETE')
  assert.match(calls[0].url, /\/v1\/flows\/flow_abc\/public-keys\/pk_1$/)
})

test('budgets.getOrg returns parsed OrgBudget', async () => {
  const { client } = build(() =>
    jsonResponse(200, {
      monthly_budget_micro_usd: 100_000_000,
      current_mtd_micro_usd: 25_000_000,
      mtd_reset_at: '2026-06-01T00:00:00.000Z',
    }),
  )
  const budget = await client.budgets.getOrg()
  assert.equal(budget.monthlyBudgetMicroUsd, 100_000_000)
  assert.equal(budget.currentMtdMicroUsd, 25_000_000)
  assert.equal(budget.mtdResetAt, '2026-06-01T00:00:00.000Z')
})

test('budgets.setOrg with null clears', async () => {
  const { client, calls } = build(() =>
    jsonResponse(200, {
      monthly_budget_micro_usd: null,
      current_mtd_micro_usd: 0,
      mtd_reset_at: '2026-06-01T00:00:00.000Z',
    }),
  )
  const budget = await client.budgets.setOrg(null)
  assert.equal(budget.monthlyBudgetMicroUsd, null)
  assert.deepEqual(calls[0].body, { monthly_budget_micro_usd: null })
})

test('constructor rejects empty apiUrl / apiKey', () => {
  assert.throws(() => new Daguito({ apiUrl: '', apiKey: 'x' }))
  assert.throws(() => new Daguito({ apiUrl: 'https://x', apiKey: '' }))
})

test('stamps X-Daguito-Client tracking headers on every request', async () => {
  let captured = null
  const fetchImpl = async (_url, init = {}) => {
    captured = init.headers ?? {}
    return jsonResponse(200, { keys: [] })
  }
  const client = new Daguito({
    apiUrl: 'https://api.example.com',
    apiKey: 'dgsk_acc_test',
    fetchImpl,
  })
  await client.accountKeys.list()
  assert.ok(captured, 'fetch invoked with headers')
  assert.match(captured['X-Daguito-Client'], /^daguito-sdk-js\/\d+\.\d+\.\d+$/)
  assert.equal(captured['X-Daguito-Client-Lang'], 'js')
  assert.match(captured['X-Daguito-Client-Version'], /^\d+\.\d+\.\d+$/)
})
