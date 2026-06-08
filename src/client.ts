/**
 * Top-level admin client — `new Daguito({ apiUrl, apiKey })`.
 *
 * Holds three admin sub-services. The existing top-level exports
 * (`runWebhook`, `WebhookStreamSession`, `WidgetSession`, …) are unchanged
 * — this client is purely additive for the admin path.
 *
 *   const client = new Daguito({ apiUrl, apiKey })
 *   const keys = await client.accountKeys.list()
 *   const created = await client.publicKeys.create('flow_abc', {
 *     name: 'browser',
 *     allowedOrigins: ['https://example.com'],
 *   })
 *   console.log(created.plaintext) // shown ONCE
 */

import { AccountKeysService } from './admin/account-keys'
import { BudgetsService } from './admin/budgets'
import { FlowsService } from './admin/flows'
import { AdminTransport } from './admin/http'
import { KnowledgeAdminService } from './admin/knowledge-admin'
import { PublicKeysService } from './admin/public-keys'
import { TemplatesService } from './admin/templates'

export interface DaguitoOptions {
  apiUrl: string
  apiKey: string
  /** Optional `fetch` override — useful in tests and custom runtimes. */
  fetchImpl?: typeof fetch
}

export class Daguito {
  readonly apiUrl: string
  readonly apiKey: string
  readonly accountKeys: AccountKeysService
  readonly publicKeys: PublicKeysService
  readonly budgets: BudgetsService
  readonly flows: FlowsService
  readonly templates: TemplatesService
  readonly knowledge: KnowledgeAdminService

  constructor(opts: DaguitoOptions) {
    if (!opts.apiUrl) throw new Error('apiUrl is required')
    if (!opts.apiKey) throw new Error('apiKey is required')
    this.apiUrl = opts.apiUrl
    this.apiKey = opts.apiKey
    const transport = new AdminTransport({
      apiUrl: opts.apiUrl,
      apiKey: opts.apiKey,
      fetchImpl: opts.fetchImpl,
    })
    this.accountKeys = new AccountKeysService(transport)
    this.publicKeys = new PublicKeysService(transport)
    this.budgets = new BudgetsService(transport)
    this.flows = new FlowsService(transport)
    this.templates = new TemplatesService(transport)
    this.knowledge = new KnowledgeAdminService(transport)
  }
}
