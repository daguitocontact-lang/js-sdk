import { createWSClient, type WSHandle } from './internal/ws-client'
import { Emitter, type Listener } from './emitter'
import { joinHttp, toWsUrl } from './url'
import { uploadFile, type UploadResult } from './widget-upload'
import type { SendableMessage, UploadableFile } from './types'

/**
 * Widget session — for embedding the chat experience on a customer's
 * site (org-scoped api_key auth, persistent session via /init, multimodal
 * send with auto-upload).
 *
 * Auth model: the org's `widget.api_key` (lives on `organizations.settings`).
 * The integrator passes `apiKey + visitorId?` and the SDK runs the init
 * handshake, opens the streaming WS, and exposes `send()` / `uploadFile()`.
 *
 * Multimodal: pass any `SendableMessage`. If the message includes a
 * File/Blob the SDK runs the presigned-upload dance for you, then sends
 * the inbound with the resulting media key. No manual two-step required.
 */

export interface WidgetSessionOptions {
  apiUrl: string
  apiKey: string
  /** Optional visitor id for re-identification across page loads. */
  visitorId?: string
}

export interface WidgetInitResult {
  sessionId: string
  orgId: string
  config: {
    brandName: string
    brandColor: string
    welcomeMessage: string
    avatarUrl: string | null
    position: string
  }
}

export type WidgetEventMap = {
  /** Initial connect frame. */
  connected: { sessionId: string }
  /** Final flow result for an inbound. */
  result: { payload: unknown }
  /** Server-side error frame. */
  error: { message: string }
  /** Transport-level close. */
  closed: { code?: number; reason?: string }
}

export class WidgetSession {
  private emitter = new Emitter<WidgetEventMap>()
  private opts: WidgetSessionOptions
  private sessionId: string | null = null
  private orgId: string | null = null
  private ws: WSHandle<unknown> | null = null

  constructor(opts: WidgetSessionOptions) {
    this.opts = opts
  }

  on<K extends keyof WidgetEventMap>(event: K, listener: Listener<WidgetEventMap[K]>): () => void {
    return this.emitter.on(event, listener)
  }

  off<K extends keyof WidgetEventMap>(event: K, listener: Listener<WidgetEventMap[K]>): void {
    this.emitter.off(event, listener)
  }

  /**
   * Run the init handshake and open the streaming WS. Resolves with the
   * server-rendered config so the integrator can paint the chat shell.
   */
  async connect(): Promise<WidgetInitResult> {
    const initUrl = joinHttp(this.opts.apiUrl, '/api/widget/init')
    const response = await fetch(initUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: this.opts.apiKey, visitor_id: this.opts.visitorId }),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`widget init HTTP ${response.status}: ${text || response.statusText}`)
    }
    const body = (await response.json()) as {
      session_id: string
      org_id: string
      config: {
        brand_name: string
        brand_color: string
        welcome_message: string
        avatar_url: string | null
        position: string
      }
    }
    this.sessionId = body.session_id
    this.orgId = body.org_id

    const url = toWsUrl(this.opts.apiUrl, '/api/ws/widget', { session_id: body.session_id })
    this.ws = createWSClient<Record<string, unknown>, Record<string, unknown>>({
      url,
      autoReconnect: true,
      heartbeatMs: 25_000,
      heartbeatMessage: () => ({ type: 'ping' }),
      isHeartbeatAck: (msg) => (msg as { type?: string }).type === 'pong',
      onMessage: (frame) => this.handleFrame(frame),
      onClose: (event) => this.emitter.emit('closed', { code: event.code, reason: event.reason }),
    })

    return {
      sessionId: body.session_id,
      orgId: body.org_id,
      config: {
        brandName: body.config.brand_name,
        brandColor: body.config.brand_color,
        welcomeMessage: body.config.welcome_message,
        avatarUrl: body.config.avatar_url,
        position: body.config.position,
      },
    }
  }

  /**
   * Send a multimodal message into the conversation. If the message
   * carries a `File`/`Blob`, the SDK uploads it via the presigned PUT
   * flow first, then sends the inbound with the resulting media key.
   *
   * For `form-response` kind the SDK posts to `/api/widget/form-response`
   * which routes the structured payload through the same coalesce path.
   */
  async send(message: SendableMessage): Promise<void> {
    if (!this.sessionId) throw new Error('widget session not connected')

    if (message.kind === 'form-response') {
      await this.sendFormResponse(message.formId, message.payload)
      return
    }

    // Auto-upload when the integrator passes a File/Blob, then rewrite the
    // message to reference the resulting media key. Switch-on-kind so TS
    // narrows each branch's literal kind correctly.
    let resolved: Exclude<SendableMessage, { kind: 'form-response' }> = message
    if (message.kind === 'image' && 'file' in message) {
      const u = await this.uploadFile({
        file: message.file,
        kind: 'image',
        filename: message.filename,
      })
      resolved = {
        kind: 'image',
        mediaKey: u.mediaKey,
        mimeType: u.mimeType,
        sizeBytes: u.sizeBytes,
        text: message.text,
      }
    } else if (message.kind === 'audio' && 'file' in message) {
      const u = await this.uploadFile({
        file: message.file,
        kind: 'audio',
        filename: message.filename,
      })
      resolved = {
        kind: 'audio',
        mediaKey: u.mediaKey,
        mimeType: u.mimeType,
        sizeBytes: u.sizeBytes,
        text: message.text,
      }
    } else if (message.kind === 'document' && 'file' in message) {
      const u = await this.uploadFile({
        file: message.file,
        kind: 'document',
        filename: message.filename,
      })
      resolved = {
        kind: 'document',
        mediaKey: u.mediaKey,
        mimeType: u.mimeType,
        sizeBytes: u.sizeBytes,
        text: message.text,
      }
    } else if (message.kind === 'video' && 'file' in message) {
      const u = await this.uploadFile({
        file: message.file,
        kind: 'video',
        filename: message.filename,
      })
      resolved = {
        kind: 'video',
        mediaKey: u.mediaKey,
        mimeType: u.mimeType,
        sizeBytes: u.sizeBytes,
        text: message.text,
      }
    }

    await this.postMessage(resolved)
  }

  /**
   * Upload a file via the presigned PUT flow. Returns the media key the
   * integrator can pass into a subsequent `send()` call. Most integrators
   * don't need this directly — `send()` calls it automatically when given
   * a `File`. Exposed for advanced cases (separate upload UI, retries).
   */
  async uploadFile(input: {
    file: UploadableFile
    kind: 'image' | 'audio' | 'document' | 'video'
    filename?: string
  }): Promise<UploadResult> {
    if (!this.sessionId) throw new Error('widget session not connected')
    return uploadFile({
      apiUrl: this.opts.apiUrl,
      apiKey: this.opts.apiKey,
      sessionId: this.sessionId,
      file: input.file,
      kind: input.kind,
      filename: input.filename,
    })
  }

  /** Tear down the session. Idempotent. */
  close(): void {
    this.ws?.close()
    this.ws = null
    this.emitter.removeAll()
  }

  /** Diagnostic accessor; integrators rarely need it. */
  getSessionId(): string | null {
    return this.sessionId
  }

  /** Diagnostic accessor. */
  getOrgId(): string | null {
    return this.orgId
  }

  private async postMessage(
    message: Exclude<SendableMessage, { kind: 'form-response' }>,
  ): Promise<void> {
    if (!this.sessionId) return
    const inbound = this.toInbound(message)
    const response = await fetch(joinHttp(this.opts.apiUrl, '/api/widget/message'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: this.sessionId,
        api_key: this.opts.apiKey,
        message: inbound,
      }),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`widget message HTTP ${response.status}: ${text || response.statusText}`)
    }
  }

  private async sendFormResponse(formId: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.sessionId) return
    const response = await fetch(joinHttp(this.opts.apiUrl, '/api/widget/form-response'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: this.sessionId,
        api_key: this.opts.apiKey,
        form_id: formId,
        payload,
      }),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(
        `widget form-response HTTP ${response.status}: ${text || response.statusText}`,
      )
    }
  }

  private toInbound(
    message: Exclude<SendableMessage, { kind: 'form-response' }>,
  ): Record<string, unknown> {
    if (message.kind === 'text') return { kind: 'text', text: message.text }
    if (message.kind === 'image-multi') {
      // Server's InboundMessageSchema doesn't have `image-multi`; the multi
      // case is encoded as kind=text with image_urls on base_input. The
      // streaming session handles this differently — for the widget surface
      // we send the first url as kind=image and pass the rest in a future
      // turn. Multi-image on widget is a niche path; surfacing via base_input
      // requires a server-side widget endpoint extension we haven't built.
      throw new Error(
        'WidgetSession.send: kind=image-multi not supported on widget; send each image as a separate text+image turn or use WebhookStreamSession',
      )
    }
    if (
      (message.kind === 'image' ||
        message.kind === 'audio' ||
        message.kind === 'document' ||
        message.kind === 'video') &&
      'mediaKey' in message
    ) {
      return {
        kind: message.kind,
        text: message.text,
        media: {
          // MediaRefSchema on the server uses `key` (not `media_key`).
          key: message.mediaKey,
          mime_type: message.mimeType,
          size_bytes: message.sizeBytes,
        },
      }
    }
    if (message.kind === 'image' && 'imageUrl' in message) {
      // imageUrl-only path: widget endpoint requires an actual mediaKey, so
      // this branch isn't supported. The integrator should fetch the URL
      // and pass it as a Blob, or use WebhookStreamSession.
      throw new Error(
        'WidgetSession.send: kind=image with imageUrl is not supported on widget; pass `file` (will auto-upload) or `mediaKey` (pre-uploaded)',
      )
    }
    throw new Error(`WidgetSession.send: unsupported message: ${JSON.stringify(message)}`)
  }

  private handleFrame(frame: Record<string, unknown>): void {
    const type = typeof frame.type === 'string' ? frame.type : ''
    if (type === 'connected') {
      this.emitter.emit('connected', {
        sessionId: String(frame.session_id ?? this.sessionId ?? ''),
      })
      return
    }
    if (type === 'result') {
      this.emitter.emit('result', { payload: frame.payload })
      return
    }
    if (type === 'error') {
      this.emitter.emit('error', { message: String(frame.message ?? 'widget error') })
    }
  }
}
