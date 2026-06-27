import { createWSClient, type WSHandle } from './internal/ws-client'
import { Emitter, type Listener } from './emitter'
import { randomSessionId, toWsUrl } from './url'
import { requiresUpload, toInboundMessage, computeBaseInput } from './internal/send-frames'
import { routeStreamFrame } from './internal/stream-dispatch'
import type { SendableMessage, StreamEventMap, WebhookStreamOptions } from './types'

/**
 * Long-lived bidirectional session for streaming webhooks
 * (`WS /v1/webhooks/:id/stream`).
 *
 * The integrator only deals in semantic events:
 *   session.on('node.token', ({ text }) => append(text))
 *   session.on('flow.completed', () => done())
 *
 * Wire-level concerns (the `ready → session.start → message` handshake,
 * frame parsing, reconnect, heartbeats) are owned by this class.
 *
 * Multimodal note: streaming webhook flows accept text + image (URL or
 * pre-uploaded media key). To upload a `File` from a webhook-only context,
 * use `WidgetSession` (the only auth surface that has a presigned-upload
 * path today).
 */
export class WebhookStreamSession {
  private emitter = new Emitter<StreamEventMap>()
  private ws: WSHandle<unknown> | null = null
  private opts: WebhookStreamOptions
  private sessionKey: string
  private startedAt = 0
  private opened = false
  private closed = false
  /**
   * Pending sends that arrived before the server emitted `session.started`.
   * The protocol requires us to wait for the start ack before pushing the
   * first message; otherwise the server replies with "no active session".
   */
  private pendingSends: Array<{ message: SendableMessage; baseInput?: Record<string, unknown> }> =
    []

  constructor(opts: WebhookStreamOptions) {
    this.opts = opts
    this.sessionKey = opts.sessionKey ?? randomSessionId('web')
  }

  /** Subscribe to a semantic event. Returns an unsubscribe function. */
  on<K extends keyof StreamEventMap>(event: K, listener: Listener<StreamEventMap[K]>): () => void {
    return this.emitter.on(event, listener)
  }

  off<K extends keyof StreamEventMap>(event: K, listener: Listener<StreamEventMap[K]>): void {
    this.emitter.off(event, listener)
  }

  /** Open the socket and run the auth + session.start handshake. Idempotent. */
  connect(): void {
    if (this.ws || this.closed) return
    const url = toWsUrl(this.opts.apiUrl, `/v1/webhooks/${this.opts.webhookId}/stream`, {
      token: this.opts.token,
    })

    this.ws = createWSClient<Record<string, unknown>, Record<string, unknown>>({
      url,
      autoReconnect: this.opts.autoReconnect ?? true,
      heartbeatMs: 25_000,
      heartbeatMessage: () => ({ type: 'ping' }),
      isHeartbeatAck: (msg) => (msg as { type?: string }).type === 'pong',
      onMessage: (frame) => this.handleFrame(frame),
      onClose: (event) => {
        this.opened = false
        this.emitter.emit('closed', { code: event.code, reason: event.reason })
      },
    })
  }

  /**
   * Send a message into the active session. Queues until `ready + session.started`
   * complete, so callers don't need to wait themselves.
   *
   * For media kinds the integrator passes either:
   *   - `imageUrl` / `imageUrls` — hosted on a public URL
   *   - `mediaKey` + `mimeType` + `sizeBytes` — pre-uploaded
   * Streaming-webhook tokens cannot mint presigned uploads; if you need to
   * upload a `File`, use `WidgetSession` or upload via your own backend.
   */
  send(message: SendableMessage, baseInput?: Record<string, unknown>): void {
    if (this.closed) return
    if (requiresUpload(message)) {
      throw new Error(
        `WebhookStreamSession.send: kind=${message.kind} with file input requires WidgetSession; use imageUrl, imageUrls or pre-uploaded mediaKey instead`,
      )
    }
    if (!this.opened) {
      this.pendingSends.push({ message, baseInput })
      this.connect()
      return
    }
    this.dispatch(message, baseInput)
  }

  /**
   * Send a raw control frame. Escape hatch for protocol extensions
   * (e.g. `session.open` for stream-trigger flows used by VoiceSession).
   * Most integrators should use `send()` instead.
   */
  sendRaw(frame: Record<string, unknown>): void {
    if (this.closed || !this.ws) return
    this.ws.send(frame)
  }

  /** Close the session. Reuses are not supported — create a fresh instance. */
  close(): void {
    this.closed = true
    if (this.ws) {
      try {
        // Best-effort end frame so the server tears down its bridge promptly
        // instead of waiting for the socket close to surface.
        this.ws.send({ type: 'session.end' })
      } catch {
        // socket may already be closing.
      }
      this.ws.close()
      this.ws = null
    }
    this.emitter.removeAll()
  }

  private dispatch(message: SendableMessage, baseInput?: Record<string, unknown>): void {
    if (!this.ws) return
    const envelope: Record<string, unknown> = { type: 'message', message: toInboundMessage(message) }
    const computedBase = {
      ...computeBaseInput(message),
      ...(baseInput ?? this.opts.baseInput),
    }
    if (Object.keys(computedBase).length > 0) envelope.base_input = computedBase
    this.ws.send(envelope)
  }

  private handleFrame(frame: Record<string, unknown>): void {
    const type = typeof frame.type === 'string' ? frame.type : ''

    if (type === 'ready') {
      this.emitter.emit('ready', { webhookId: String(frame.webhook_id ?? this.opts.webhookId) })
      this.ws?.send({ type: 'session.start', session_key: this.sessionKey })
      return
    }

    if (type === 'session.started') {
      this.opened = true
      this.startedAt = Date.now()
      const queued = this.pendingSends.splice(0)
      for (const { message, baseInput } of queued) this.dispatch(message, baseInput)
      return
    }

    if (type === 'session.ended') {
      this.opened = false
      return
    }

    if (type === 'pong') return // already handled by heartbeat ack

    routeStreamFrame(frame, this.emitter, { startedAt: this.startedAt })
  }
}
