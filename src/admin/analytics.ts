/**
 * Analytics service — `client.analytics.getOrg()`.
 *
 * One-call usage snapshot for the org bound to the API key. Backs
 * `GET /v1/org/analytics`. Every number is read from Redis counters or a
 * single indexed Postgres count, so it stays cheap to poll.
 */

import { AdminTransport, DaguitoError } from './http'

export interface OrgAnalytics {
  orgId: string
  llmToday: {
    requests: number
    tokens: number
    costUsd: number
  }
  messagesToday: {
    inbound: Record<string, number>
    outboundLast24h: number
  }
  httpToday: {
    total: number
    byPath: Record<string, number>
  }
  budget: {
    orgCapMicroUsd: number
    orgMtdMicroUsd: number
    keyCapMicroUsd: number
    keyMtdMicroUsd: number
  }
}

interface OrgAnalyticsWire {
  org_id?: string
  llm_today?: { requests?: number; tokens?: number; cost_usd?: number }
  messages_today?: { inbound?: Record<string, number>; outbound_last_24h?: number }
  http_today?: { total?: number; by_path?: Record<string, number> }
  budget?: {
    org_cap_micro_usd?: number
    org_mtd_micro_usd?: number
    key_cap_micro_usd?: number
    key_mtd_micro_usd?: number
  }
}

export class AnalyticsService {
  constructor(private readonly transport: AdminTransport) {}

  async getOrg(): Promise<OrgAnalytics> {
    const data = await this.transport.request<OrgAnalyticsWire>('GET', '/v1/org/analytics')
    if (!data) throw new DaguitoError('getOrg: empty response')
    return mapOrgAnalytics(data)
  }
}

function mapOrgAnalytics(wire: OrgAnalyticsWire): OrgAnalytics {
  const llm = wire.llm_today ?? {}
  const messages = wire.messages_today ?? {}
  const http = wire.http_today ?? {}
  const budget = wire.budget ?? {}
  return {
    orgId: wire.org_id ?? '',
    llmToday: {
      requests: llm.requests ?? 0,
      tokens: llm.tokens ?? 0,
      costUsd: llm.cost_usd ?? 0,
    },
    messagesToday: {
      inbound: messages.inbound ?? {},
      outboundLast24h: messages.outbound_last_24h ?? 0,
    },
    httpToday: {
      total: http.total ?? 0,
      byPath: http.by_path ?? {},
    },
    budget: {
      orgCapMicroUsd: budget.org_cap_micro_usd ?? 0,
      orgMtdMicroUsd: budget.org_mtd_micro_usd ?? 0,
      keyCapMicroUsd: budget.key_cap_micro_usd ?? 0,
      keyMtdMicroUsd: budget.key_mtd_micro_usd ?? 0,
    },
  }
}
