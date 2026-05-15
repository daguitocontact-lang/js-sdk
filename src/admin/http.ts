/**
 * Shared HTTP helper for the admin client services.
 *
 * Lives under `src/admin/http.ts` so all three services (`accountKeys`,
 * `publicKeys`, `budgets`) reuse the same Bearer/4xx/JSON plumbing.
 */

import { clientHeaders } from '../internal/client-headers'
import { joinHttp } from '../url'

export class DaguitoError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'DaguitoError'
  }
}

export interface AdminTransportOptions {
  apiUrl: string
  apiKey: string
  /** Optional override — useful in tests and custom runtimes. */
  fetchImpl?: typeof fetch
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export class AdminTransport {
  private readonly opts: AdminTransportOptions

  constructor(opts: AdminTransportOptions) {
    this.opts = opts
  }

  url(path: string): string {
    return joinHttp(this.opts.apiUrl, path)
  }

  async request<T>(method: Method, path: string, body?: unknown): Promise<T | null> {
    const url = this.url(path)
    const fetchImpl = this.opts.fetchImpl ?? fetch
    let response: Response
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.apiKey}`,
          ...clientHeaders(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (err) {
      throw new DaguitoError(err instanceof Error ? err.message : 'network error')
    }

    if (response.status === 204) return null

    if (!response.ok) {
      const message = await extractErrorMessage(response)
      throw new DaguitoError(message, response.status)
    }

    const text = await response.text().catch(() => '')
    if (!text) return null
    try {
      return JSON.parse(text) as T
    } catch (err) {
      throw new DaguitoError(
        `invalid JSON response: ${err instanceof Error ? err.message : String(err)}`,
        response.status,
      )
    }
  }
}

async function extractErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  if (!text) return response.statusText || `HTTP ${response.status}`
  try {
    const parsed = JSON.parse(text) as { error?: string; message?: string }
    if (parsed && typeof parsed.error === 'string') return parsed.error
    if (parsed && typeof parsed.message === 'string') return parsed.message
  } catch {
    // Body wasn't JSON — fall through to raw text.
  }
  return text || response.statusText || `HTTP ${response.status}`
}
