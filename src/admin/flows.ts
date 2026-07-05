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
    // Be lenient: accept snake_case aliases too (system_prompt, max_tokens, …),
    // so callers who mirror the HTTP / MCP-tool field names don't hit a 422.
    const raw = input as unknown as Record<string, unknown>
    const pick = (camel: unknown, snake: string): unknown => camel ?? raw[snake]

    const body: Record<string, unknown> = {
      slug: input.slug,
      name: input.name,
      provider: input.provider,
      model: input.model,
      system_prompt: pick(input.systemPrompt, 'system_prompt'),
    }
    const set = (key: string, value: unknown) => {
      if (value !== undefined) body[key] = value
    }
    set('vision_model', pick(input.visionModel, 'vision_model'))
    set('temperature', input.temperature)
    set('max_tokens', pick(input.maxTokens, 'max_tokens'))
    set('history_turns', pick(input.historyTurns, 'history_turns'))
    set('recent_turns', pick(input.recentTurns, 'recent_turns'))
    set('max_tool_iterations', pick(input.maxToolIterations, 'max_tool_iterations'))
    set('tools', input.tools)
    set('memory_facts_schema', pick(input.memoryFactsSchema, 'memory_facts_schema'))
    set('memory_summary_config', pick(input.memorySummaryConfig, 'memory_summary_config'))
    set('context_memory_keys', pick(input.contextMemoryKeys, 'context_memory_keys'))
    set('trigger_channels', pick(input.triggerChannels, 'trigger_channels'))

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
    // The engine keys each node's handler off `config.step_type` and detects
    // the entry node by `type === 'trigger'`. Callers naturally set only the
    // node's `kind`, so backfill both `type` and `config.step_type` from it —
    // otherwise the graph is rejected (400) or the trigger runs as a step.
    const nodes = input.graph.nodes.map((node) => {
      const stepType = node.config?.step_type ?? node.kind ?? node.type
      return {
        ...node,
        ...(stepType ? { type: node.type ?? stepType } : {}),
        config: { ...(node.config ?? {}), ...(stepType ? { step_type: stepType } : {}) },
      }
    })
    const body: Record<string, unknown> = {
      slug: input.slug,
      name: input.name,
      graph: { nodes, edges: input.graph.edges },
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
