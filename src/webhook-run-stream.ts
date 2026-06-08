/**
 * One-shot wrapper over `WebhookStreamSession`. Opens the WS, sends one
 * message, waits for `flow.completed`, closes, and returns the final output —
 * exactly like `runWebhook` HTTP, but without the 100 s edge timeout the
 * proxy enforces on HTTP. For flows that may run longer than a HTTP request
 * is willing to wait (long generations, vision pipelines, multi-step tools).
 *
 * The shape of the resolved value matches `WebhookRunResult` so callers can
 * swap from `runWebhook` to `runWebhookStream` without touching their
 * parsing code.
 */

import { Emitter } from './emitter'
import type { StreamEventMap } from './types'
import { WebhookStreamSession } from './webhook-stream-session'

export interface WebhookRunStreamInput {
  apiUrl: string
  /** Streaming webhook id (`wh_...`). Resolve via `client.flows.resolveWebhook(slug)`. */
  webhookId: string
  /** Webhook token (`sk_wh_...`). */
  token: string
  /** Free-form input passed to the flow as `base_input`. */
  input?: Record<string, unknown>
  /** Inline message text sent on the WS. Defaults to a single space when the
   * caller only wants to deliver `input` (the flow may not need a user-facing
   * message at all — webhook agents start from `base_input`). */
  text?: string
  /** Optional caller-supplied session key (defaults to a fresh uuid). */
  sessionKey?: string
  /** Caller's AbortSignal — aborting closes the WS and rejects the promise. */
  signal?: AbortSignal
  /** Optional ceiling that rejects if the flow has not completed in time.
   * No default — WS has no edge timeout, so this is opt-in. */
  timeoutMs?: number
}

export interface WebhookRunStreamResult {
  ok: boolean
  executionId: string
  status: 'completed' | 'failed' | 'unknown'
  output: unknown
  elapsedMs: number
}

export class WebhookStreamRunError extends Error {
  constructor(
    message: string,
    public readonly status?: 'failed' | 'timeout' | 'aborted' | 'closed',
  ) {
    super(message)
    this.name = 'WebhookStreamRunError'
  }
}

export async function runWebhookStream(
  input: WebhookRunStreamInput,
): Promise<WebhookRunStreamResult> {
  const session = new WebhookStreamSession({
    apiUrl: input.apiUrl,
    webhookId: input.webhookId,
    token: input.token,
    sessionKey: input.sessionKey,
    baseInput: input.input,
    autoReconnect: false,
  })

  const tokenBuffer: string[] = []
  // Collect `node.completed` outputs in order so we can fall back when the
  // server does not emit `flow.completed` with an `output`.
  const nodeOutputs: unknown[] = []

  return new Promise<WebhookRunStreamResult>((resolve, reject) => {
    let settled = false
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    let abortHandler: (() => void) | null = null

    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (abortHandler && input.signal) input.signal.removeEventListener('abort', abortHandler)
      try {
        session.close()
      } catch {
        // ignore close errors — the session is already in teardown
      }
    }

    const finish = (result: WebhookRunStreamResult) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    const fail = (err: WebhookStreamRunError) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    bindEvents(session.on.bind(session) as Emitter<StreamEventMap>['on'], {
      tokenBuffer,
      nodeOutputs,
      onCompleted: (status, output, elapsedMs, executionId) => {
        finish({ ok: status === 'completed', executionId, status, output, elapsedMs })
      },
      onFailed: (msg) => fail(new WebhookStreamRunError(msg, 'failed')),
    })

    if (input.signal) {
      if (input.signal.aborted) {
        fail(new WebhookStreamRunError('aborted', 'aborted'))
        return
      }
      abortHandler = () => fail(new WebhookStreamRunError('aborted', 'aborted'))
      input.signal.addEventListener('abort', abortHandler, { once: true })
    }

    if (input.timeoutMs && input.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        fail(new WebhookStreamRunError(`timed out after ${input.timeoutMs}ms`, 'timeout'))
      }, input.timeoutMs)
    }

    session.send({ kind: 'text', text: input.text ?? ' ' }, input.input)
  })
}

function bindEvents(
  on: Emitter<StreamEventMap>['on'],
  ctx: {
    tokenBuffer: string[]
    nodeOutputs: unknown[]
    onCompleted: (
      status: 'completed' | 'failed' | 'unknown',
      output: unknown,
      elapsedMs: number,
      executionId: string,
    ) => void
    onFailed: (msg: string) => void
  },
): void {
  let executionId = ''

  on('node.token', ({ text }) => {
    ctx.tokenBuffer.push(text)
  })

  on('node.completed', ({ output }) => {
    if (output !== undefined) ctx.nodeOutputs.push(output)
  })

  on('node.emit', (evt) => {
    // Surface a generated execution_id when the server includes it; useful
    // for log correlation in case the flow fails silently.
    const data = evt.data as { execution_id?: unknown }
    if (typeof data.execution_id === 'string' && data.execution_id) {
      executionId = data.execution_id
    }
  })

  on('flow.completed', ({ elapsedMs, output }) => {
    const finalOutput =
      output !== undefined
        ? output
        : ctx.nodeOutputs.length > 0
          ? ctx.nodeOutputs[ctx.nodeOutputs.length - 1]
          : ctx.tokenBuffer.length > 0
            ? { content: ctx.tokenBuffer.join('') }
            : null
    ctx.onCompleted('completed', finalOutput, elapsedMs, executionId)
  })

  on('flow.failed', ({ error }) => {
    ctx.onFailed(error || 'flow failed')
  })

  on('error', ({ message }) => {
    ctx.onFailed(message || 'transport error')
  })
}
