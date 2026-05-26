/**
 * Knowledge admin service — `client.knowledge.{listBases,listSources,…}`.
 *
 * Wraps the public knowledge management surface under `/api/public/knowledge/*`.
 * Auth = the org account API key. Distinct from `KnowledgeSession`, which is
 * the runtime ingest/search session (and is org-scoped via a different key
 * shape). The admin service covers CRUD over bases/sources and async ingest
 * job polling — it does not do hybrid retrieval.
 */

import { AdminTransport, DaguitoError } from './http'

export interface KnowledgeBase {
  id: string
  name: string
  description: string | null
  dim: number
  tenancy_tier: string
  embedding_provider: string
  embedding_model: string
}

export interface KnowledgeSourceSummary {
  id: string
  org_id: string
  kb_id: string
  name: string
  description: string | null
  kind: string
  status: string
  chunk_count: number
  token_count: number
  source_count: number
  created_at: string
  updated_at: string
}

export interface CreateKnowledgeSourceInput {
  orgId: string
  name: string
  description?: string
  kind?: 'url' | 'file' | 'text' | 'sitemap'
}

export interface KnowledgeSource {
  id: string
  org_id: string
  kb_id: string
  name: string
  description: string | null
  kind: string
  status: string
  chunk_count: number
  token_count: number
  created_at: string
  updated_at: string
}

export interface IngestUrlInput {
  url: string
  metadata?: Record<string, unknown>
}

export interface IngestTextInput {
  text: string
  metadata?: Record<string, unknown>
}

export interface IngestResult {
  source_id: string
  chunk_count: number
  token_count: number
}

export interface IngestJobStatus {
  job_id: string
  status: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'unknown'
  org_id?: string
  progress?: unknown
  result?: unknown
  error?: string
  created_at?: number
  finished_at?: number
}

export interface DeleteChunksByMetadataInput {
  metadataKey: string
  metadataValue: string
}

export interface DeleteChunksByMetadataResult {
  deletedCount: number
}

export interface UpdateChunksMetadataInput {
  match: { metadataKey: string; metadataValue: string }
  patch: Record<string, unknown>
}

export interface UpdateChunksMetadataResult {
  updatedCount: number
}

export class KnowledgeAdminService {
  constructor(private readonly transport: AdminTransport) {}

  async listBases(opts: { orgId?: string } = {}): Promise<KnowledgeBase[]> {
    const path = opts.orgId
      ? `/api/public/knowledge/bases?org_id=${encodeURIComponent(opts.orgId)}`
      : '/api/public/knowledge/bases'
    const data = await this.transport.request<{ bases: KnowledgeBase[] }>('GET', path)
    return data?.bases ?? []
  }

  async listSources(opts: { orgId?: string } = {}): Promise<KnowledgeSourceSummary[]> {
    const path = opts.orgId
      ? `/api/public/knowledge/sources?org_id=${encodeURIComponent(opts.orgId)}`
      : '/api/public/knowledge/sources'
    const data = await this.transport.request<{ sources: KnowledgeSourceSummary[] }>('GET', path)
    return data?.sources ?? []
  }

  async createSource(input: CreateKnowledgeSourceInput): Promise<KnowledgeSource> {
    const body: Record<string, unknown> = {
      org_id: input.orgId,
      name: input.name,
    }
    if (input.description !== undefined) body.description = input.description
    if (input.kind !== undefined) body.kind = input.kind
    const data = await this.transport.request<{ source: KnowledgeSource | null; error?: string }>(
      'POST',
      '/api/public/knowledge/sources',
      body,
    )
    if (!data?.source) throw new DaguitoError(data?.error ?? 'create source failed')
    return data.source
  }

  async ingestUrl(sourceId: string, input: IngestUrlInput): Promise<IngestResult> {
    const body: Record<string, unknown> = { url: input.url }
    if (input.metadata !== undefined) body.metadata = input.metadata
    const data = await this.transport.request<IngestResult & { error?: string }>(
      'POST',
      `/api/public/knowledge/sources/${encodeURIComponent(sourceId)}/url`,
      body,
    )
    if (!data) throw new DaguitoError('ingestUrl: empty response')
    if (data.error) throw new DaguitoError(data.error)
    return data
  }

  async ingestText(sourceId: string, input: IngestTextInput): Promise<IngestResult> {
    const body: Record<string, unknown> = { text: input.text }
    if (input.metadata !== undefined) body.metadata = input.metadata
    const data = await this.transport.request<IngestResult & { error?: string }>(
      'POST',
      `/api/public/knowledge/sources/${encodeURIComponent(sourceId)}/text`,
      body,
    )
    if (!data) throw new DaguitoError('ingestText: empty response')
    if (data.error) throw new DaguitoError(data.error)
    return data
  }

  async getIngestJob(jobId: string): Promise<IngestJobStatus> {
    const data = await this.transport.request<IngestJobStatus & { error?: string }>(
      'GET',
      `/api/public/knowledge/ingest-jobs/${encodeURIComponent(jobId)}`,
    )
    if (!data) throw new DaguitoError('getIngestJob: empty response')
    return data
  }

  async deleteChunksByMetadata(
    sourceId: string,
    input: DeleteChunksByMetadataInput,
  ): Promise<DeleteChunksByMetadataResult> {
    if (!sourceId) throw new DaguitoError('deleteChunksByMetadata: sourceId required')
    if (!input?.metadataKey) {
      throw new DaguitoError('deleteChunksByMetadata: metadataKey required')
    }
    const qs = new URLSearchParams({
      metadata_key: input.metadataKey,
      metadata_value: String(input.metadataValue ?? ''),
    })
    const path = `/api/public/knowledge/sources/${encodeURIComponent(sourceId)}/chunks?${qs.toString()}`
    const data = await this.transport.request<{ deleted_count?: number; error?: string }>(
      'DELETE',
      path,
    )
    if (!data) throw new DaguitoError('deleteChunksByMetadata: empty response')
    if (data.error) throw new DaguitoError(data.error)
    return { deletedCount: typeof data.deleted_count === 'number' ? data.deleted_count : 0 }
  }

  async updateChunksMetadata(
    sourceId: string,
    input: UpdateChunksMetadataInput,
  ): Promise<UpdateChunksMetadataResult> {
    if (!sourceId) throw new DaguitoError('updateChunksMetadata: sourceId required')
    if (!input?.match?.metadataKey) {
      throw new DaguitoError('updateChunksMetadata: match.metadataKey required')
    }
    if (!input.patch || typeof input.patch !== 'object') {
      throw new DaguitoError('updateChunksMetadata: patch object required')
    }
    const body = {
      match: {
        metadata_key: input.match.metadataKey,
        metadata_value: String(input.match.metadataValue ?? ''),
      },
      patch: input.patch,
    }
    const path = `/api/public/knowledge/sources/${encodeURIComponent(sourceId)}/chunks`
    const data = await this.transport.request<{ updated_count?: number; error?: string }>(
      'PATCH',
      path,
      body,
    )
    if (!data) throw new DaguitoError('updateChunksMetadata: empty response')
    if (data.error) throw new DaguitoError(data.error)
    return { updatedCount: typeof data.updated_count === 'number' ? data.updated_count : 0 }
  }
}
