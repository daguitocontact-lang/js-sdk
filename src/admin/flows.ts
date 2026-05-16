/**
 * Flow resolution service — `client.flows.resolveWebhook(slug)`.
 *
 * Resolves a flow by slug (in the org the API key belongs to) and returns
 * its streaming webhook id + a usable `sk_wh_…` token, so a client can
 * open AudioStreamSession / WebhookStreamSession without hardcoding webhook
 * credentials. Backed by `GET /api/sdk/flows?slug=…`, auth = the org API
 * key (`sk_dgt_…`, scope `flow:run`).
 */

import { AdminTransport, DaguitoError } from './http'

export interface ResolvedFlowWebhook {
  flowId: string
  slug: string
  name: string
  webhookId: string
  webhookToken: string
}

interface ResolvedFlowWebhookWire {
  flow_id: string
  slug: string
  name: string
  webhook_id: string
  webhook_token: string
}

export class FlowsService {
  constructor(private readonly transport: AdminTransport) {}

  async resolveWebhook(slug: string): Promise<ResolvedFlowWebhook> {
    const data = await this.transport.request<ResolvedFlowWebhookWire>(
      'GET',
      `/api/sdk/flows?slug=${encodeURIComponent(slug)}`,
    )
    if (!data) {
      throw new DaguitoError('resolveWebhook: empty response')
    }
    return {
      flowId: data.flow_id,
      slug: data.slug,
      name: data.name,
      webhookId: data.webhook_id,
      webhookToken: data.webhook_token,
    }
  }
}
