/**
 * One-shot HTTP webhook from Node. Smallest possible smoke test.
 *
 * Usage:
 *   DAGUITO_API_URL=https://api.daguito.com \
 *   DAGUITO_TOKEN=sk_wh_xxxxxxxx \
 *   node examples/run-webhook.mjs "What's the price of BTC?"
 */

import { runWebhook } from '../dist/index.js'

const apiUrl = process.env.DAGUITO_API_URL ?? 'https://api.daguito.com'
const token = process.env.DAGUITO_TOKEN
const question = process.argv[2] ?? 'Hola'

if (!token) {
  console.error('Set DAGUITO_TOKEN=sk_wh_xxx')
  process.exit(1)
}

console.log(`POST ${apiUrl}/h/${token.slice(0, 8)}…`)
console.log(`> ${question}`)

const result = await runWebhook({
  apiUrl,
  token,
  input: { question },
  timeoutMs: 60_000,
})

console.log()
console.log(`status:       ${result.status}`)
console.log(`execution_id: ${result.executionId}`)
console.log(`output:`)
console.log(JSON.stringify(result.output, null, 2))
