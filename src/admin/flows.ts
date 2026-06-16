/**
 * Flow admin service — resolution, agent upsert, and custom-graph upsert.
 *
 *   - `resolveWebhook(slug)`        → `GET  /api/sdk/flows?slug=…`
 *   - `upsertAgent({slug,name,…})`  → `POST /v1/flows/upsert-agent` (preset
 *     `trigger → ai_agent` graph; the most common case).
 *   - `upsertFlow({slug,name,…})`   → `POST /v1/flows/upsert` (any node/edge
 *     graph; escape hatch for vision pipelines, OCR chains, etc).
 *
 * All three auth with the org account API key (`sk_dgt_…`).
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

export interface HandlerToolRef {
  kind: 'handler'
  name: string
  config?: Record<string, unknown>
}

export interface UpsertAgentInput {
  slug: string
  name: string
  provider: 'openrouter' | 'deepseek' | 'openai' | 'gemini' | 'opencode'
  model: string
  /** Vision-capable model for image/audio turns. Set it to enable native media
   *  (the model sees the real image; audio transcripts ride inline). */
  visionModel?: string
  systemPrompt: string
  temperature?: number
  maxTokens?: number
  historyTurns?: number
  recentTurns?: number
  maxToolIterations?: number
  tools?: HandlerToolRef[]
  memoryFactsSchema?: unknown
  memorySummaryConfig?: Record<string, unknown>
  contextMemoryKeys?: string[]
  triggerChannels?: 'webhook'[]
}

export interface UpsertAgentResult {
  flowId: string
  slug: string
  name: string
  webhookId: string
  created: boolean
}

interface UpsertAgentWire {
  flow_id: string
  slug: string
  name: string
  webhook_id: string
  created: boolean
}

export interface FlowGraphNode {
  id: string
  kind?: string
  type?: string
  label?: string
  config?: Record<string, unknown>
  position?: { x: number; y: number }
}

export interface FlowGraphEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
}

export interface UpsertFlowInput {
  slug: string
  name: string
  triggerType?: string
  graph: {
    nodes: FlowGraphNode[]
    edges: FlowGraphEdge[]
  }
}

export interface UpsertFlowResult {
  flowId: string
  slug: string
  name: string
  webhookId: string
  created: boolean
}

interface UpsertFlowWire {
  flow_id: string
  slug: string
  name: string
  webhook_id: string
  created: boolean
}

export class FlowsService {
  constructor(private readonly transport: AdminTransport) {}

  async resolveWebhook(slug: string): Promise<ResolvedFlowWebhook> {
    const data = await this.transport.request<ResolvedFlowWebhookWire>(
      'GET',
      `/api/sdk/flows?slug=${encodeURIComponent(slug)}`,
    )
    if (!data) throw new DaguitoError('resolveWebhook: empty response')
    return {
      flowId: data.flow_id,
      slug: data.slug,
      name: data.name,
      webhookId: data.webhook_id,
      webhookToken: data.webhook_token,
    }
  }

  async upsertAgent(input: UpsertAgentInput): Promise<UpsertAgentResult> {
    const body: Record<string, unknown> = {
      slug: input.slug,
      name: input.name,
      provider: input.provider,
      model: input.model,
      system_prompt: input.systemPrompt,
    }
    if (input.visionModel !== undefined) body.vision_model = input.visionModel
    if (input.temperature !== undefined) body.temperature = input.temperature
    if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens
    if (input.historyTurns !== undefined) body.history_turns = input.historyTurns
    if (input.recentTurns !== undefined) body.recent_turns = input.recentTurns
    if (input.maxToolIterations !== undefined) body.max_tool_iterations = input.maxToolIterations
    if (input.tools !== undefined) body.tools = input.tools
    if (input.memoryFactsSchema !== undefined) body.memory_facts_schema = input.memoryFactsSchema
    if (input.memorySummaryConfig !== undefined) body.memory_summary_config = input.memorySummaryConfig
    if (input.contextMemoryKeys !== undefined) body.context_memory_keys = input.contextMemoryKeys
    if (input.triggerChannels !== undefined) body.trigger_channels = input.triggerChannels

    const data = await this.transport.request<UpsertAgentWire & { error?: string }>(
      'POST',
      '/v1/flows/upsert-agent',
      body,
    )
    if (!data) throw new DaguitoError('upsertAgent: empty response')
    if (data.error) throw new DaguitoError(data.error)
    return {
      flowId: data.flow_id,
      slug: data.slug,
      name: data.name,
      webhookId: data.webhook_id,
      created: data.created,
    }
  }

  async upsertFlow(input: UpsertFlowInput): Promise<UpsertFlowResult> {
    const body: Record<string, unknown> = {
      slug: input.slug,
      name: input.name,
      graph: input.graph,
    }
    if (input.triggerType !== undefined) body.trigger_type = input.triggerType

    const data = await this.transport.request<UpsertFlowWire & { error?: string }>(
      'POST',
      '/v1/flows/upsert',
      body,
    )
    if (!data) throw new DaguitoError('upsertFlow: empty response')
    if (data.error) throw new DaguitoError(data.error)
    return {
      flowId: data.flow_id,
      slug: data.slug,
      name: data.name,
      webhookId: data.webhook_id,
      created: data.created,
    }
  }
}
