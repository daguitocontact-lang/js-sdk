/**
 * LIVE proof that the input/output streaming feature actually REACHES a running
 * Daguito — not an in-process server (that's flow-streaming-e2e), but the same
 * deployment the product hits.
 *
 * A real `OutputStream` consumes, over a real WebSocket, the frames a real flow
 * run emits, driven by a real `InputStream` producing the input. Exercises the
 * whole live chain: dst_ mint endpoint, streaming-ws auth (sk_wh_ produce +
 * dst_ consume), coalesce → worker → engine, durable Redis stream → fan-out.
 *
 * Gated on DAGUITO_API_URL + DAGUITO_API_KEY (skips in CI without a stack):
 *
 *   DAGUITO_API_URL=http://localhost:4001 \
 *   DAGUITO_API_KEY=sk_dgt_... \
 *   bun test src/__tests__/streaming-live.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Daguito } from '../client'
import { OutputStream } from '../output-stream'
import { InputStream } from '../input-stream'
import { mintStreamToken } from '../stream-token'

const apiUrl = process.env.DAGUITO_API_URL
const apiKey = process.env.DAGUITO_API_KEY
const liveDescribe = apiUrl && apiKey ? describe : describe.skip

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitUntil(fn: () => boolean, timeoutMs: number, stepMs = 100): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true
    await sleep(stepMs)
  }
  return fn()
}

liveDescribe('live streaming reaches Daguito', () => {
  const client = new Daguito({ apiUrl: apiUrl as string, apiKey: apiKey as string })
  const slug = 'sdk-stream-live-test'
  const sessionKey = `stream-live:${Date.now()}`
  let webhookId = ''
  let webhookToken = ''
  const streams: Array<{ close: () => void }> = []

  beforeAll(async () => {
    const up = await client.flows.upsertAgent({
      slug,
      name: 'SDK Streaming Live (e2e)',
      provider: 'openrouter',
      model: 'deepseek/deepseek-chat-v3-0324',
      systemPrompt: 'You are a test agent. Reply with exactly one short word.',
    })
    webhookId = up.webhookId
    const resolved = await client.flows.resolveWebhook(slug)
    webhookToken = resolved.webhookToken
  })

  afterAll(() => {
    // upsertAgent is idempotent on `slug`, so re-running reuses the same flow
    // rather than piling up — the admin SDK exposes no delete to clean up here.
    for (const s of streams) {
      try {
        s.close()
      } catch {
        /* best-effort */
      }
    }
  })

  test('the live API mints a session-scoped consume dst_ token', async () => {
    const minted = await mintStreamToken({
      apiUrl: apiUrl as string,
      webhookId,
      token: webhookToken,
      sessionKey,
      role: 'consume',
    })
    expect(minted.token.startsWith('dst_')).toBe(true)
    expect(minted.role).toBe('consume')
    expect(minted.sessionKey).toBe(sessionKey)
    expect(minted.expiresAt).toBeGreaterThan(0)
  })

  test(
    'OutputStream receives real flow frames produced by InputStream over the live socket',
    async () => {
      const consume = await mintStreamToken({
        apiUrl: apiUrl as string,
        webhookId,
        token: webhookToken,
        sessionKey,
        role: 'consume',
      })

      const tokens: string[] = []
      const emits: string[] = []
      let completed = false
      let ready = false
      let errored = ''

      const out = new OutputStream({
        apiUrl: apiUrl as string,
        webhookId,
        token: consume.token,
        sessionKey,
      })
      streams.push(out)
      out.on('ready', () => {
        ready = true
      })
      out.on('node.token', ({ text }) => {
        if (text) tokens.push(text)
      })
      out.on('node.emit', ({ kind }) => {
        emits.push(String(kind))
      })
      out.on('flow.completed', () => {
        completed = true
      })
      out.on('error', ({ message }) => {
        errored = message
      })

      // Attach the consumer before producing so we tail from the start.
      await waitUntil(() => ready, 8000)
      expect(errored).toBe('')
      expect(ready).toBe(true)
      await sleep(400) // let session.start round-trip before producing

      const input = new InputStream({
        apiUrl: apiUrl as string,
        webhookId,
        token: webhookToken,
        sessionKey,
      })
      streams.push(input)
      input.on('error', ({ message }) => {
        errored = message
      })
      input.sendText('ping')

      // The whole point: streamed output actually arrived from the live flow.
      const got = await waitUntil(() => completed || tokens.length > 0 || emits.length > 0, 60000)
      expect(errored).toBe('')
      expect(got).toBe(true)
      expect(tokens.length + emits.length).toBeGreaterThan(0)
    },
    70000,
  )
})
