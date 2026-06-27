import { createWSClient, type WSHandle } from './internal/ws-client'
import { Emitter, type Listener } from './emitter'
import { toWsUrl } from './url'
import { routeStreamFrame } from './internal/stream-dispatch'
import type { OutputStreamOptions, StreamEventMap } from './types'

/**
 * Output-only consumer of a flow channel (`session.start { mode: 'consume' }`).
 *
 * Subscribes to every FlowEvent a session emits — `node.token`, `node.emit`
 * (tool progress, streaming updates), `flow.completed`, … — without sending any
 * input. Built for fan-out: a locutor + thousands of listeners, a doctor + a
 * patient both watching, a backend persisting results.
 *
 * Durable + resumable: it reads the session's Redis Stream, so a listener that
 * joins mid-broadcast starts at the live tail, and a reconnecting one resumes
 * from its last cursor with no gap (the SDK tracks the cursor automatically).
 *
 *   const out = new OutputStream({ apiUrl, webhookId, token, sessionKey })
 *   out.on('node.emit', ({ kind, data }) => render(kind, data))
 *   out.on('flow.completed', ({ output }) => done(output))
 *
 * Connects on construction so events are never missed; attach listeners
 * synchronously right after `new` (the socket opens on the next tick).
 */
export class OutputStream {
  private emitter = new Emitter<StreamEventMap>()
  private ws: WSHandle<unknown> | null = null
  private opts: OutputStreamOptions
  private cursor: string | undefined
  private startedAt = 0
  private closed = false

  constructor(opts: OutputStreamOptions) {
    this.opts = opts
    this.cursor = opts.resumeFrom
    this.connect()
  }

  /** Subscribe to a semantic event. Returns an unsubscribe function. */
  on<K extends keyof StreamEventMap>(event: K, listener: Listener<StreamEventMap[K]>): () => void {
    return this.emitter.on(event, listener)
  }

  off<K extends keyof StreamEventMap>(event: K, listener: Listener<StreamEventMap[K]>): void {
    this.emitter.off(event, listener)
  }

  /** Open the socket and run the consume handshake. Idempotent. */
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
      onClose: (event) => this.emitter.emit('closed', { code: event.code, reason: event.reason }),
    })
  }

  /** The last durable cursor seen. Persist it to resume a fresh session later. */
  get resumeCursor(): string | undefined {
    return this.cursor
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

  private startSession(): void {
    const frame: Record<string, unknown> = { type: 'session.start', mode: 'consume' }
    // Optional when a scoped `dst_` token already binds the session_key.
    if (this.opts.sessionKey) frame.session_key = this.opts.sessionKey
    // Resume from the latest cursor (set on every frame) so a reconnect — the
    // server re-emits `ready` — picks up exactly where we left off.
    if (this.cursor) frame.resume_from = this.cursor
    this.ws?.send(frame)
  }

  private handleFrame(frame: Record<string, unknown>): void {
    const type = typeof frame.type === 'string' ? frame.type : ''

    if (type === 'ready') {
      this.emitter.emit('ready', { webhookId: String(frame.webhook_id ?? this.opts.webhookId) })
      this.startSession()
      return
    }
    if (type === 'session.started') {
      this.startedAt = Date.now()
      return
    }
    if (type === 'session.ended' || type === 'pong') return

    const cursor = routeStreamFrame(frame, this.emitter, { startedAt: this.startedAt })
    if (cursor) this.cursor = cursor
  }
}
