/**
 * Self-contained smoke test. Spins up a mock Daguito server (HTTP +
 * WebSocket) inside this process, points the SDK at it, and verifies
 * the protocol flow end-to-end. No real backend needed.
 *
 *   node examples/mock-server-smoke.mjs
 *
 * Exits 0 on success, non-zero on failure.
 */

import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { runWebhook, WebhookStreamSession } from '../dist/index.js'

let exitCode = 0

// 1) Mock /h/:token — one-shot webhook
function startHttpServer() {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/h/')) {
      res.writeHead(404).end('not found')
      return
    }
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const input = body ? JSON.parse(body) : {}
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          execution_id: 'exec_mock_123',
          status: 'completed',
          output: { echo: input },
        }),
      )
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ url: `http://127.0.0.1:${port}`, server })
    })
  })
}

// 2) Mock WS /v1/webhooks/:id/stream — streaming webhook
function startWsServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: undefined })
  // Accept any path that ends in /stream — the SDK picks the URL.
  wss.on('connection', (socket, req) => {
    if (!req.url?.includes('/stream')) {
      socket.close()
      return
    }
    socket.send(JSON.stringify({ type: 'ready', webhook_id: 'wh_mock' }))

    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'session.start') {
        socket.send(JSON.stringify({ type: 'session.started', session_key: msg.session_key }))
        return
      }
      if (msg.type === 'message') {
        // Replay a typical flow: node.started → 3 tokens → node.completed → flow.completed
        const at = () => new Date().toISOString()
        socket.send(
          JSON.stringify({
            type: 'node.started',
            node_id: 'agent',
            session_key: 'mock',
            at: at(),
            data: {},
          }),
        )
        for (const text of ['Hola', ' mundo', '!']) {
          socket.send(
            JSON.stringify({
              type: 'node.token',
              node_id: 'agent',
              session_key: 'mock',
              at: at(),
              data: { text },
            }),
          )
        }
        socket.send(
          JSON.stringify({
            type: 'node.completed',
            node_id: 'agent',
            session_key: 'mock',
            at: at(),
            data: { duration_ms: 42, output: { content: 'Hola mundo!' } },
          }),
        )
        socket.send(
          JSON.stringify({
            type: 'flow.completed',
            session_key: 'mock',
            at: at(),
            data: { output: { content: 'Hola mundo!' } },
          }),
        )
      }
      if (msg.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', at: new Date().toISOString() }))
      }
    })
  })
}

// === Test 1: runWebhook (HTTP) ===
async function testRunWebhook(apiUrl) {
  console.log('test 1: runWebhook (one-shot HTTP)')
  const result = await runWebhook({
    apiUrl,
    token: 'sk_wh_mock',
    input: { question: 'ping?' },
  })
  if (!result.ok) throw new Error(`runWebhook: ok=false`)
  if (result.executionId !== 'exec_mock_123') throw new Error(`runWebhook: bad execution_id`)
  if (result.output?.echo?.question !== 'ping?') throw new Error(`runWebhook: echo missed input`)
  console.log('  ✓ ok=true, execution_id, output.echo round-trip')
}

// === Test 2: WebhookStreamSession (WS) ===
function testStreamSession(apiUrl) {
  console.log('test 2: WebhookStreamSession (streaming WS)')
  return new Promise((resolve, reject) => {
    const session = new WebhookStreamSession({
      apiUrl,
      webhookId: 'wh_mock',
      token: 'sk_wh_mock',
      autoReconnect: false,
    })

    let tokens = ''
    let nodeStartedSeen = false
    let nodeCompletedDuration = 0

    const timeout = setTimeout(() => reject(new Error('test 2 timed out')), 5_000)

    session.on('ready', () => {})
    session.on('node.started', () => {
      nodeStartedSeen = true
    })
    session.on('node.token', ({ text }) => {
      tokens += text
    })
    session.on('node.completed', ({ durationMs }) => {
      nodeCompletedDuration = durationMs ?? 0
    })
    session.on('flow.completed', () => {
      clearTimeout(timeout)
      session.close()
      try {
        if (!nodeStartedSeen) throw new Error('no node.started')
        if (tokens !== 'Hola mundo!') throw new Error(`tokens="${tokens}"`)
        if (nodeCompletedDuration !== 42) throw new Error(`durationMs=${nodeCompletedDuration}`)
        console.log('  ✓ node.started, 3 tokens streamed, node.completed durationMs')
        console.log('  ✓ flow.completed received')
        resolve()
      } catch (err) {
        reject(err)
      }
    })
    session.on('flow.failed', ({ error }) => {
      clearTimeout(timeout)
      reject(new Error(`flow.failed: ${error}`))
    })
    session.on('error', ({ message }) => {
      clearTimeout(timeout)
      reject(new Error(`error: ${message}`))
    })

    session.send({ kind: 'text', text: 'hola' })
  })
}

// === Run all ===
const { url: apiUrl, server } = await startHttpServer()
startWsServer(server)
console.log(`mock server: ${apiUrl}`)
console.log()

try {
  await testRunWebhook(apiUrl)
  await testStreamSession(apiUrl)
  console.log()
  console.log('all tests passed ✓')
} catch (err) {
  console.error()
  console.error(`FAILED: ${err.message}`)
  exitCode = 1
} finally {
  server.close()
  process.exit(exitCode)
}
