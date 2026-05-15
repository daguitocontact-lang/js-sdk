import { clientHeaders } from './internal/client-headers'
import { joinHttp } from './url'

/**
 * One-shot webhook invocation against `POST /h/:token`. Use this for
 * non-streaming flows where you just want the final output (synchronous
 * request/response). For streaming flows that emit tokens or progress, use
 * `WebhookStreamSession` instead.
 *
 * The webhook owner controls which trigger type each token activates;
 * `/h/:token` only works for tokens issued for an HTTP-style webhook.
 */

export interface WebhookRunInput {
  apiUrl: string
  /** The raw token (NOT a URL). The path embeds it server-side. */
  token: string
  /** Free-form input passed to the flow as `base_input`. */
  input?: Record<string, unknown>
  signal?: AbortSignal
  timeoutMs?: number
}

export interface WebhookRunResult {
  ok: boolean
  executionId: string
  status: string
  output: unknown
}

export class WebhookError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'WebhookError'
  }
}

export async function runWebhook(input: WebhookRunInput): Promise<WebhookRunResult> {
  const url = joinHttp(input.apiUrl, `/h/${encodeURIComponent(input.token)}`)
  const controller = new AbortController()
  const timeoutId =
    input.timeoutMs && input.timeoutMs > 0
      ? setTimeout(() => controller.abort(), input.timeoutMs)
      : null

  // Chain caller's abort signal into our timeout controller so an external
  // cancel still aborts the in-flight request.
  if (input.signal) {
    if (input.signal.aborted) controller.abort()
    else input.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...clientHeaders() },
      body: JSON.stringify(input.input ?? {}),
      signal: controller.signal,
    })
  } catch (err) {
    throw new WebhookError(err instanceof Error ? err.message : 'network error')
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new WebhookError(
      `HTTP ${response.status}: ${text || response.statusText}`,
      response.status,
    )
  }

  const body = (await response.json()) as {
    ok?: boolean
    execution_id?: string
    status?: string
    output?: unknown
    error?: string
  }
  if (body.error) throw new WebhookError(body.error, response.status)
  return {
    ok: body.ok ?? false,
    executionId: body.execution_id ?? '',
    status: body.status ?? 'unknown',
    output: body.output,
  }
}
