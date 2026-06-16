/**
 * Models service — `client.models.list()`.
 *
 * Lists every LLM the platform currently exposes through its provider
 * resolver. Backs `GET /v1/models`. Each entry surfaces just enough metadata
 * to populate a model-picker (`provider`, `id`, `displayName`, optional
 * `tier`) — the full pricing / context-window record lives on the dashboard.
 */

import { AdminTransport, DaguitoError } from './http'

export interface Model {
  provider: string
  id: string
  displayName: string
  tier?: string
}

interface ModelWire {
  provider?: string
  id?: string
  displayName?: string
  tier?: string
}

interface ModelListEnvelopeWire {
  models?: ModelWire[]
}

export class ModelsService {
  constructor(private readonly transport: AdminTransport) {}

  async list(): Promise<Model[]> {
    const data = await this.transport.request<ModelListEnvelopeWire>('GET', '/v1/models')
    if (!data) throw new DaguitoError('list: empty response')
    const raw = data.models ?? []
    return raw.map((w) => ({
      provider: w.provider ?? '',
      id: w.id ?? '',
      displayName: w.displayName ?? w.id ?? '',
      tier: w.tier,
    }))
  }
}
