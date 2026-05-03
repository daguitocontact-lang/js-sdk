/**
 * Streaming webhook from Node. Prints tokens as they arrive, the node
 * lifecycle, and the final flow result.
 *
 * Usage:
 *   DAGUITO_API_URL=https://api.daguito.com \
 *   DAGUITO_WEBHOOK_ID=wh_abc123 \
 *   DAGUITO_TOKEN=sk_wh_xxxxxxxx \
 *   node examples/stream-webhook.mjs "Cuéntame un cuento corto"
 */

import { WebhookStreamSession } from '../dist/index.js'

const apiUrl = process.env.DAGUITO_API_URL ?? 'https://api.daguito.com'
const webhookId = process.env.DAGUITO_WEBHOOK_ID
const token = process.env.DAGUITO_TOKEN
const message = process.argv[2] ?? 'Hola'

if (!webhookId || !token) {
  console.error('Set DAGUITO_WEBHOOK_ID=wh_xxx and DAGUITO_TOKEN=sk_wh_xxx')
  process.exit(1)
}

const session = new WebhookStreamSession({ apiUrl, webhookId, token, autoReconnect: false })

session.on('ready', () => console.log('[ready]'))
session.on('node.started', ({ nodeId }) => console.log(`[start]  ${nodeId}`))
session.on('node.token', ({ text }) => process.stdout.write(text))
session.on('node.completed', ({ nodeId, durationMs }) => {
  console.log(`\n[done]   ${nodeId}${durationMs ? ` (${durationMs}ms)` : ''}`)
})
session.on('node.failed', ({ nodeId, error }) => {
  console.log(`\n[fail]   ${nodeId}: ${error ?? 'unknown'}`)
})
session.on('node.emit', ({ nodeId, kind, data }) => {
  console.log(`[emit]   ${nodeId} → ${kind}`, JSON.stringify(data).slice(0, 120))
})
session.on('flow.completed', ({ elapsedMs }) => {
  console.log(`\n[flow.completed] ${elapsedMs}ms`)
  session.close()
  process.exit(0)
})
session.on('flow.failed', ({ error }) => {
  console.log(`\n[flow.failed] ${error}`)
  session.close()
  process.exit(1)
})
session.on('error', ({ message }) => console.error(`[error] ${message}`))

session.send({ kind: 'text', text: message })

// Idle timeout in case the server never closes the flow.
setTimeout(
  () => {
    console.error('\n[timeout] no flow.completed in 5 minutes')
    session.close()
    process.exit(2)
  },
  5 * 60 * 1000,
)
