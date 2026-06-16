/**
 * Node catalog service — `client.nodes.getCatalog()`.
 *
 * Lists every flow node type the engine has registered, grouped by category.
 * Used by builder UIs and by anyone composing a `FlowGraph` to pick valid
 * `step_type` values for `upsertFlow`. Backs `GET /api/public/nodes/catalog`.
 *
 * The wire shape uses snake_case (`step_type`, `default_config`, …); we
 * pass it through verbatim because the catalog is downstream metadata the
 * caller hands straight to a flow graph and remapping every nested key
 * would be lossy. Consumers treat it as the source of truth.
 */

import { AdminTransport, DaguitoError } from './http'

export interface NodeCatalogCategory {
  key: string
  label: string
  order: number
}

export interface NodeCatalogPort {
  name: string
  type: string
  description?: string
}

export interface NodeCatalogEntry {
  step_type: string
  category: string
  label: string
  description: string
  icon: string
  default_config: Record<string, unknown>
  inputs: NodeCatalogPort[]
  outputs: NodeCatalogPort[]
  branches: Record<string, unknown>
  inputs_mode?: string
  emits?: Array<{ kind: string; description: string }>
}

export interface NodeCatalog {
  categories: NodeCatalogCategory[]
  nodes: NodeCatalogEntry[]
}

export class NodesService {
  constructor(private readonly transport: AdminTransport) {}

  async getCatalog(): Promise<NodeCatalog> {
    const data = await this.transport.request<NodeCatalog>('GET', '/api/public/nodes/catalog')
    if (!data) throw new DaguitoError('getCatalog: empty response')
    return data
  }
}
