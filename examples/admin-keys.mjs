/**
 * Administer API keys + budgets programmatically with the `Daguito` client.
 *
 *   1. Connect with a `dgsk_acc_…` org-admin key.
 *   2. List existing account keys.
 *   3. Create a public flow key for $DAGUITO_FLOW_ID, allowed_origins=["https://example.com"].
 *   4. Patch its budget to $50/month (50_000_000 micro-USD).
 *   5. List public keys to confirm the change.
 *   6. Revoke it.
 *
 * Usage:
 *
 *   DAGUITO_API_URL=https://ingest.daguito.com \
 *   DAGUITO_API_KEY=dgsk_acc_xxxxxxxxxxxx \
 *   DAGUITO_FLOW_ID=flow_abc123 \
 *   node examples/admin-keys.mjs
 */

import { Daguito } from '../dist/index.js'

const apiUrl = process.env.DAGUITO_API_URL ?? 'https://ingest.daguito.com'
const apiKey = process.env.DAGUITO_API_KEY
const flowId = process.env.DAGUITO_FLOW_ID

if (!apiKey) {
  console.error('Set DAGUITO_API_KEY=dgsk_acc_...')
  process.exit(1)
}
if (!flowId) {
  console.error('Set DAGUITO_FLOW_ID=flow_...')
  process.exit(1)
}

// 1. Single client, three sub-services.
const client = new Daguito({ apiUrl, apiKey })

// 2. List existing org-wide account keys.
const keys = await client.accountKeys.list()
console.log(`[account-keys] ${keys.length} key(s) active`)
for (const key of keys) {
  console.log(`  - ${key.keyPrefix}  name=${JSON.stringify(key.name)}  mtd=${key.currentMtdMicroUsd}μ$`)
}

// 3. Mint a public flow key for embedding in a browser.
const created = await client.publicKeys.create(flowId, {
  name: 'example-com integration',
  allowedOrigins: ['https://example.com'],
})
console.log(`[public-key]  created ${created.keyPrefix}`)
console.log(`               plaintext (shown ONCE): ${created.plaintext}`)

// 4. Cap the new key at $50/month (5e7 micro-USD).
const updated = await client.publicKeys.setBudget(flowId, created.id, 50_000_000)
console.log(`[public-key]  budget set to ${updated.monthlyBudgetMicroUsd}μ$`)

// 5. Confirm via list.
const listing = await client.publicKeys.list(flowId)
const match = listing.find((k) => k.id === created.id)
if (match) console.log(`[verify]     ${match.keyPrefix} budget=${match.monthlyBudgetMicroUsd}μ$`)

// 6. Revoke (soft delete — never deleted in the DB).
await client.publicKeys.revoke(flowId, created.id)
console.log(`[public-key]  revoked ${created.keyPrefix}`)
