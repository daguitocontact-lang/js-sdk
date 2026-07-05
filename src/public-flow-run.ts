import { clientHeaders } from './internal/client-headers'
import { joinHttp } from './url'

/**
 * Run a flow directly from the browser with a public flow key (`dgpk_flow_…`).
 *
 * The frontend-only path: no backend, no account key. Mint a domain-locked
 * public flow key once (`client.publicKeys.create(flowId, { allowedOrigins })`)
 * and call this from the allowed origin. The server enforces the origin
 * allowlist, so this only works from a real browser (the browser sends the
 * `Origin` header automatically — Node/curl callers are rejected by design;
 * use a webhook token or account key server-side instead).
 *
 *   const res = await runPublicFlow({
 *     apiUrl: 'https://ingest.daguito.com',
 *     publicKey: 'dgpk_flow_…',
 *     text: 'Do you ship to Bogotá?',
 *   })
 *   console.log(res.output)
 */
export interface RunPublicFlowInput {
  apiUrl: string
  /** Public flow key (`dgpk_flow_…`), safe to embed on its allowed origins. */
  publicKey: string
  /** User message delivered to the flow's agent (read as `input.text`). */
  text?: string
  /** Extra fields merged into the flow's input. */
  input?: Record<string, unknown>
  /** Reject if the flow has not completed in time. */
  timeoutMs?: number
}

export interface RunPublicFlowResult {
  ok: boolean
  executionId: string
  status: 'completed' | 'failed' | 'unknown'
  output: unknown
}

export class PublicFlowError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'PublicFlowError'
  }
}

export async function runPublicFlow(input: RunPublicFlowInput): Promise<RunPublicFlowResult> {
  const url = joinHttp(input.apiUrl, '/v1/public/run')
  const controller = input.timeoutMs ? new AbortController() : undefined
  const timer = controller ? setTimeout(() => controller.abort(), input.timeoutMs) : undefined

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.publicKey}`,
        ...clientHeaders(),
      },
      body: JSON.stringify({ text: input.text, input: input.input }),
      signal: controller?.signal,
    })
  } catch (err) {
    if (timer) clearTimeout(timer)
    throw new PublicFlowError(err instanceof Error ? err.message : 'network error')
  }
  if (timer) clearTimeout(timer)

  const text = await response.text().catch(() => '')
  if (!response.ok) {
    throw new PublicFlowError(text || response.statusText, response.status)
  }
  const body = (text ? JSON.parse(text) : {}) as {
    ok?: boolean
    execution_id?: string
    status?: RunPublicFlowResult['status']
    output?: unknown
  }
  return {
    ok: Boolean(body.ok),
    executionId: body.execution_id ?? '',
    status: body.status ?? 'unknown',
    output: body.output,
  }
}
