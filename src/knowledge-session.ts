import { clientHeaders } from './internal/client-headers'
import { joinHttp } from './url'

/**
 * Knowledge session — HTTP client for ingest + search against Daguito's
 * Knowledge Base endpoints. Auth uses an `sk_dgt_...` API key sent via
 * `Authorization: Bearer ...`. The key's scopes (`kb:write`, `kb:read`)
 * govern which methods succeed; both calls 401 without a key, 403 without
 * the right scope.
 *
 * Pure request/response — no streaming, no events, no persistent connection.
 * Works in browser AND Node 18+ (uses only the global `fetch`).
 */

export interface KnowledgeSessionOptions {
  apiUrl: string
  apiKey: string
  /** Default sourceId for all ingestText calls (can override per call). */
  defaultSourceId?: string
}

export interface IngestTextInput {
  /** The text to ingest. Required. */
  text: string
  /** Optional metadata stamped on every chunk. */
  metadata?: Record<string, unknown>
  /** Override the session's defaultSourceId. */
  sourceId?: string
}

export interface IngestTextResult {
  sourceId: string
  chunkCount: number
  tokenCount: number
}

export interface SearchInput {
  query: string
  topK?: number
  sourceIds?: string[]
  enableRewrite?: boolean
  enableRerank?: boolean
  enableCache?: boolean
  /**
   * Strict equality filter on chunk metadata. A chunk is returned only if every
   * key/value here matches its metadata exactly — use it to scope a shared,
   * multi-tenant source to one tenant (e.g. `{ user_id: 'abc' }`). Sent to the
   * server as `metadata_equals`.
   */
  metadataEquals?: Record<string, unknown>
}

export interface SearchHit {
  id: string
  sourceId: string
  content: string
  score: number
  metadata: Record<string, unknown>
}

export interface SearchResult {
  hits: SearchHit[]
  queryOriginal: string
  queryRewritten?: string
  /** Raw response from server — kept for advanced inspection. */
  raw: unknown
}

export class KnowledgeError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'KnowledgeError'
  }
}

interface IngestTextResponse {
  source_id?: string
  chunk_count?: number
  token_count?: number
}

interface SearchChunk {
  id?: string
  source_id?: string
  content?: string
  score?: number
  metadata?: Record<string, unknown>
}

interface SearchResponse {
  chunks?: SearchChunk[]
  query_original?: string
  query_rewritten?: string
}

interface ErrorResponse {
  error?: string
}

export class KnowledgeSession {
  private readonly opts: KnowledgeSessionOptions

  constructor(opts: KnowledgeSessionOptions) {
    this.opts = opts
  }

  async ingestText(input: IngestTextInput): Promise<IngestTextResult> {
    const sourceId = input.sourceId ?? this.opts.defaultSourceId
    if (!sourceId) {
      throw new KnowledgeError(
        'sourceId required (pass to method or set defaultSourceId on the session)',
      )
    }

    const url = joinHttp(
      this.opts.apiUrl,
      `/api/sdk/knowledge/sources/${encodeURIComponent(sourceId)}/text`,
    )
    const response = await this.post(url, {
      text: input.text,
      metadata: input.metadata,
    })

    const body = (await this.parseJson(response)) as IngestTextResponse
    return {
      sourceId: body.source_id ?? sourceId,
      chunkCount: body.chunk_count ?? 0,
      tokenCount: body.token_count ?? 0,
    }
  }

  async search(input: SearchInput): Promise<SearchResult> {
    const url = joinHttp(this.opts.apiUrl, '/api/sdk/knowledge/search')
    const response = await this.post(url, {
      query: input.query,
      top_k: input.topK,
      source_ids: input.sourceIds,
      enable_rewrite: input.enableRewrite,
      enable_rerank: input.enableRerank,
      enable_cache: input.enableCache,
      metadata_equals: input.metadataEquals,
    })

    const body = (await this.parseJson(response)) as SearchResponse
    const chunks = Array.isArray(body.chunks) ? body.chunks : []
    const hits: SearchHit[] = chunks.map((chunk) => ({
      id: chunk.id ?? '',
      sourceId: chunk.source_id ?? '',
      content: chunk.content ?? '',
      score: typeof chunk.score === 'number' ? chunk.score : 0,
      metadata: chunk.metadata ?? {},
    }))

    return {
      hits,
      queryOriginal: body.query_original ?? input.query,
      queryRewritten: body.query_rewritten,
      raw: body,
    }
  }

  private async post(url: string, body: Record<string, unknown>): Promise<Response> {
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.apiKey}`,
          ...clientHeaders(),
        },
        body: JSON.stringify(body),
      })
    } catch (err) {
      throw new KnowledgeError(err instanceof Error ? err.message : 'network error')
    }

    if (!response.ok) {
      const message = await this.extractErrorMessage(response)
      throw new KnowledgeError(message, response.status)
    }
    return response
  }

  private async parseJson(response: Response): Promise<unknown> {
    try {
      return await response.json()
    } catch (err) {
      throw new KnowledgeError(
        `invalid JSON response: ${err instanceof Error ? err.message : String(err)}`,
        response.status,
      )
    }
  }

  private async extractErrorMessage(response: Response): Promise<string> {
    const text = await response.text().catch(() => '')
    if (!text) return response.statusText || `HTTP ${response.status}`
    try {
      const parsed = JSON.parse(text) as ErrorResponse
      if (parsed && typeof parsed.error === 'string') return parsed.error
    } catch {
      // Body wasn't JSON — fall through to raw text.
    }
    return text || response.statusText || `HTTP ${response.status}`
  }
}
