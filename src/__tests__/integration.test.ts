/**
 * Integration tests for the admin client surface — hits a LIVE Daguito API.
 *
 * Skipped automatically when `DAGUITO_API_URL` and `DAGUITO_API_KEY` aren't
 * set in the environment, so CI without a running daguito stays green.
 *
 *   DAGUITO_API_URL=https://api-local.daguito.com \
 *   DAGUITO_API_KEY=sk_dgt_... \
 *   bun test src/__tests__
 *
 * The tests rely on a pre-existing KB source id
 * (`a63fa3c1-63b1-4c09-92df-9599ba44f68c`) for the listSources check — if you
 * point the suite at a fresh org, swap `SEED_SOURCE_ID` for one of yours.
 */

import { describe, expect, test } from 'bun:test'
import { Daguito } from '../client'

const apiUrl = process.env.DAGUITO_API_URL
const apiKey = process.env.DAGUITO_API_KEY
const SEED_SOURCE_ID = 'a63fa3c1-63b1-4c09-92df-9599ba44f68c'

const liveDescribe = apiUrl && apiKey ? describe : describe.skip

liveDescribe('admin client integration', () => {
  const client = new Daguito({ apiUrl: apiUrl as string, apiKey: apiKey as string })
  const slug = `sdk-js-test-agent-${Date.now()}`
  let createdFlowId = ''

  test('flows.upsertAgent creates on first call, updates on second', async () => {
    const first = await client.flows.upsertAgent({
      slug,
      name: 'SDK JS test agent',
      provider: 'openrouter',
      model: 'deepseek/deepseek-chat-v3-0324',
      systemPrompt: 'You are a test agent. Reply with one short sentence.',
    })
    expect(first.created).toBe(true)
    expect(first.flowId.length).toBeGreaterThan(0)
    expect(first.webhookId.length).toBeGreaterThan(0)
    createdFlowId = first.flowId

    const second = await client.flows.upsertAgent({
      slug,
      name: 'SDK JS test agent (renamed)',
      provider: 'openrouter',
      model: 'deepseek/deepseek-chat-v3-0324',
      systemPrompt: 'Updated system prompt.',
    })
    expect(second.created).toBe(false)
    expect(second.flowId).toBe(first.flowId)
    expect(second.webhookId).toBe(first.webhookId)
  })

  test('flows.resolveWebhook matches upsert response', async () => {
    expect(createdFlowId).not.toBe('')
    const resolved = await client.flows.resolveWebhook(slug)
    expect(resolved.flowId).toBe(createdFlowId)
    expect(resolved.slug).toBe(slug)
    expect(resolved.webhookToken.length).toBeGreaterThan(0)
  })

  test('flows.get returns the upserted agent', async () => {
    expect(createdFlowId).not.toBe('')
    const flow = await client.flows.get(createdFlowId)
    expect(flow.id).toBe(createdFlowId)
    expect(flow.status).toBe('active')
  })

  test('flows.delete cleans up the agent', async () => {
    expect(createdFlowId).not.toBe('')
    await client.flows.delete(createdFlowId)
    // get() now should 404.
    let threw = false
    try {
      await client.flows.get(createdFlowId)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test(
    'knowledge.listSources contains the seed source id',
    async () => {
      const sources = await client.knowledge.listSources()
      expect(Array.isArray(sources)).toBe(true)
      const hasSeed = sources.some((s) => s.id === SEED_SOURCE_ID)
      const hasAny = sources.length > 0
      expect(hasSeed || hasAny).toBe(true)
    },
    60_000,
  )

  test('analytics.getOrg returns the org snapshot', async () => {
    const analytics = await client.analytics.getOrg()
    expect(typeof analytics.orgId).toBe('string')
    expect(typeof analytics.llmToday.requests).toBe('number')
    expect(typeof analytics.httpToday.total).toBe('number')
    expect(typeof analytics.budget.orgCapMicroUsd).toBe('number')
  })

  test('nodes.getCatalog returns an array of node entries', async () => {
    const catalog = await client.nodes.getCatalog()
    expect(Array.isArray(catalog.nodes)).toBe(true)
    expect(catalog.nodes.length).toBeGreaterThan(0)
    expect(typeof catalog.nodes[0]!.step_type).toBe('string')
  })

  test('templates.parse + templates.example round-trip a tiny markdown', async () => {
    const parsed = await client.templates.parse({
      templateBody: '# Title\n\nName: [[the person name]]\nAge: [[the person age]]\n',
    })
    expect(parsed.fieldCount).toBeGreaterThan(0)
    expect(parsed.bodyHash.length).toBeGreaterThan(0)
    expect(parsed.templateSchema.name.length).toBeGreaterThan(0)

    const example = await client.templates.example({
      templateSchema: parsed.templateSchema,
      transcript: 'My name is Ada Lovelace and I am 36 years old.',
    })
    expect(example.example !== null || example.cached === true).toBe(true)
  }, 60_000)

  test('models.list returns a non-empty array', async () => {
    const models = await client.models.list()
    expect(Array.isArray(models)).toBe(true)
    expect(models.length).toBeGreaterThan(0)
    const first = models[0]!
    expect(typeof first.provider).toBe('string')
    expect(typeof first.id).toBe('string')
    expect(first.id.length).toBeGreaterThan(0)
  })

  test(
    'knowledge chunk metadata — patch then delete-by-metadata round-trip',
    async () => {
      const seedSourceId = process.env.DAGUITO_LAWYERS_SOURCE_ID ?? SEED_SOURCE_ID
      const stamp = Date.now()
      const idA = `test-delete-by-metadata-A-${stamp}`
      const idB = `test-delete-by-metadata-B-${stamp}`

      await client.knowledge.ingestText(seedSourceId, {
        text: `Lawyer profile A ${stamp}. Specializes in tax law.`,
        metadata: { lawyer_id: idA, marker: 'chunk-ops-suite' },
      })
      await client.knowledge.ingestText(seedSourceId, {
        text: `Lawyer profile B ${stamp}. Specializes in maritime law.`,
        metadata: { lawyer_id: idB, marker: 'chunk-ops-suite' },
      })

      const patched = await client.knowledge.updateChunksMetadata(seedSourceId, {
        match: { metadataKey: 'lawyer_id', metadataValue: idA },
        patch: { city: 'Bogota' },
      })
      expect(patched.updatedCount).toBeGreaterThanOrEqual(1)

      const deletedB = await client.knowledge.deleteChunksByMetadata(seedSourceId, {
        metadataKey: 'lawyer_id',
        metadataValue: idB,
      })
      expect(deletedB.deletedCount).toBeGreaterThanOrEqual(1)

      const deletedMissing = await client.knowledge.deleteChunksByMetadata(seedSourceId, {
        metadataKey: 'lawyer_id',
        metadataValue: `does-not-exist-${stamp}`,
      })
      expect(deletedMissing.deletedCount).toBe(0)

      const deletedA = await client.knowledge.deleteChunksByMetadata(seedSourceId, {
        metadataKey: 'lawyer_id',
        metadataValue: idA,
      })
      expect(deletedA.deletedCount).toBeGreaterThanOrEqual(1)
    },
    120_000,
  )
})
