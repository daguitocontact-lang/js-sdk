import { clientHeaders } from './internal/client-headers'
import { joinHttp } from './url'
import type { StreamTokenInput, StreamTokenResult } from './types'

/**
 * Mint a short-lived, session-scoped stream token (`dst_...`) so an untrusted
 * client (a browser) can attach to ONE flow channel as producer or consumer
 * WITHOUT ever holding the webhook secret.
 *
 * Call this on a TRUSTED backend (it sends the webhook secret as Bearer); then
 * hand the returned `dst_` token to the browser, which passes it to
 * `InputStream` / `OutputStream` / `FlowChannel`.
 *
 *   // backend
 *   const { token } = await mintStreamToken({
 *     apiUrl, webhookId, token: WEBHOOK_SECRET,
 *     sessionKey: consultationId, role: 'consume',
 *   })
 *   // → ship `token` to the patient's browser
 */
export class StreamTokenError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'StreamTokenError'
  }
}

export async function mintStreamToken(input: StreamTokenInput): Promise<StreamTokenResult> {
  const url = joinHttp(input.apiUrl, `/v1/webhooks/${encodeURIComponent(input.webhookId)}/stream-tokens`)

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.token}`,
        ...clientHeaders(),
      },
      body: JSON.stringify({
        session_key: input.sessionKey,
        ...(input.role ? { role: input.role } : {}),
        ...(input.ttlSeconds ? { ttl_seconds: input.ttlSeconds } : {}),
      }),
    })
  } catch (err) {
    throw new StreamTokenError(err instanceof Error ? err.message : 'network error')
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new StreamTokenError(
      `HTTP ${response.status}: ${text || response.statusText}`,
      response.status,
    )
  }

  const body = (await response.json()) as {
    token?: string
    session_key?: string
    role?: StreamTokenResult['role']
    expires_at?: number
    error?: string
  }
  if (body.error) throw new StreamTokenError(body.error, response.status)
  return {
    token: body.token ?? '',
    sessionKey: body.session_key ?? input.sessionKey,
    role: body.role ?? input.role ?? 'consume',
    expiresAt: body.expires_at ?? 0,
  }
}
