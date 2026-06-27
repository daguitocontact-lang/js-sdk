import { createWSClient, type WSHandle } from './internal/ws-client'
import { Emitter, type Listener } from './emitter'
import { toWsUrl } from './url'
import { requiresUpload, toInboundMessage, computeBaseInput } from './internal/send-frames'
import type { InputStreamOptions, SendableMessage, StreamEventMap } from './types'

/**
 * Input-only producer for a flow channel (`session.start { mode: 'produce' }`).
 *
 * Pushes input into a shared `sessionKey` without opening an output bridge — so
 * many writers can fan IN cheaply (10 patients + 1 doctor, a meeting's members)
 * with the output consumed elsewhere by `OutputStream`(s).
 *
 *   const input = new InputStream({ apiUrl, webhookId, token, sessionKey })
 *   input.sendText('tos seca hace 3 días')
 *   input.open()   // for stream-trigger flows with no initial message
 *
 * Connects lazily on the first send. Only `ready` / `closed` / `error` events
 * fire here — the flow's output goes to consumers, not the producer.
 */
export class InputStream {
  private emitter = new Emitter<StreamEventMap>()
  private ws: WSHandle<unknown> | null = null
  private opts: InputStreamOptions
  private opened = false
  private closed = false
  /** Frames built before `session.started` — flushed in order once it lands. */
  private pending: Array<Record<string, unknown>> = []

  constructor(opts: InputStreamOptions) {
    this.opts = opts
  }

  on<K extends keyof StreamEventMap>(event: K, listener: Listener<StreamEventMap[K]>): () => void {
    return this.emitter.on(event, listener)
  }

  off<K extends keyof StreamEventMap>(event: K, listener: Listener<StreamEventMap[K]>): void {
    this.emitter.off(event, listener)
  }

  /** Open the socket and run the produce handshake. Idempotent. */
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

  /** Send a message into the shared session. Queues until the session starts. */
  send(message: SendableMessage, baseInput?: Record<string, unknown>): void {
    if (this.closed) return
    if (requiresUpload(message)) {
      throw new Error(
        `InputStream.send: kind=${message.kind} with file input requires WidgetSession; use imageUrl, imageUrls or pre-uploaded mediaKey instead`,
      )
    }
    const envelope: Record<string, unknown> = {
      type: 'message',
      message: toInboundMessage(message),
    }
    const base = { ...computeBaseInput(message), ...(baseInput ?? this.opts.baseInput) }
    if (Object.keys(base).length > 0) envelope.base_input = base
    this.enqueue(envelope)
  }

  /** Convenience for the common text case. */
  sendText(text: string, baseInput?: Record<string, unknown>): void {
    this.send({ kind: 'text', text }, baseInput)
  }

  /**
   * Trigger the flow run for this session — for stream-trigger flows that start
   * without an initial message (voice/live). Producers/bidi only.
   */
  open(baseInput?: Record<string, unknown>): void {
    this.enqueue({ type: 'session.open', ...(baseInput ? { base_input: baseInput } : {}) })
  }

  /** Abort the running flow execution this producer opened. */
  cancel(): void {
    this.enqueue({ type: 'cancel' })
  }

  close(): void {
    this.closed = true
    if (this.ws) {
      try {
        this.ws.send({ type: 'session.end' })
      } catch {
        // socket may already be closing.
      }
      this.ws.close()
      this.ws = null
    }
    this.emitter.removeAll()
  }

  private enqueue(frame: Record<string, unknown>): void {
    if (this.closed) return
    if (!this.opened) {
      this.pending.push(frame)
      this.connect()
      return
    }
    this.ws?.send(frame)
  }

  private startFrame(): Record<string, unknown> {
    const frame: Record<string, unknown> = { type: 'session.start', mode: 'produce' }
    if (this.opts.sessionKey) frame.session_key = this.opts.sessionKey
    return frame
  }

  private handleFrame(frame: Record<string, unknown>): void {
    const type = typeof frame.type === 'string' ? frame.type : ''

    if (type === 'ready') {
      this.emitter.emit('ready', { webhookId: String(frame.webhook_id ?? this.opts.webhookId) })
      this.ws?.send(this.startFrame())
      return
    }
    if (type === 'session.started') {
      this.opened = true
      const queued = this.pending.splice(0)
      for (const f of queued) this.ws?.send(f)
      return
    }
    if (type === 'session.ended') {
      this.opened = false
      return
    }
    if (type === 'pong') return
    if (type === 'error') {
      this.emitter.emit('error', { message: String(frame.message ?? 'unknown error') })
    }
  }
}
