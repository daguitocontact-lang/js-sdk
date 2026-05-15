import { Emitter, type Listener } from '../emitter'
import { appendClientQueryParams } from '../internal/client-headers'
import { WebhookStreamSession } from '../webhook-stream-session'
import { startMicCapture, pickAudioWsTransport, arrayBufferToBase64 } from './mic-capture'
import { createTtsPlayer, base64ToBytes, type TtsPlayer } from './tts-player'
import { randomSessionId, toWsUrl } from '../url'
import type { StreamEventMap } from '../types'

/**
 * Full voice agent session: mic → audio WS → flow engine → events WS →
 * streaming TTS playback. The integrator only deals in semantic events:
 *
 *   const session = new VoiceSession({ apiUrl, webhookId, token })
 *   session.on('transcript.partial', ({ text }) => showLive(text))
 *   session.on('transcript.final', ({ text }) => append(text))
 *   session.on('tts.url', ({ url }) => audioEl.src = url)
 *   session.on('node.token', ({ text }) => append(text))
 *   await session.start()
 *
 * Voice surfaces ALL the WebhookStreamSession events plus voice-only
 * additions (transcript.*, tts.*). Reusing the stream session means
 * a future protocol tweak only needs to land in one place.
 *
 * Browser-only — uses `getUserMedia`, `AudioWorklet`, `MediaSource`. Will
 * throw on Node. Import from `@daguito/sdk/voice`.
 */

export type VoiceEventMap = StreamEventMap & {
  /** STT partial (interim) result. */
  'transcript.partial': { text: string }
  /** STT final result for an utterance. */
  'transcript.final': { text: string }
  /** STT error from the upstream provider. */
  'transcript.error': { error: string }
  /** Mic level (0..1 RMS) for live "is the user speaking" UI. */
  'mic.level': { rms: number }
  /** Server emitted a TTS audio chunk — bytes are already buffered internally. */
  'tts.chunk': { bytes: number; index: number }
  /** Playable URL for the current utterance — attach to an `<audio>` element. */
  'tts.url': { url: string }
  /** Server signalled end-of-utterance. */
  'tts.done': { totalBytes: number }
  /** TTS provider error. */
  'tts.error': { error: string }
  /** Lifecycle: voice session ready (mic + sockets up). */
  'voice.ready': Record<string, never>
  /** Lifecycle: voice session stopped (user or transport). */
  'voice.stopped': { elapsedMs: number }
}

export interface VoiceSessionOptions {
  apiUrl: string
  webhookId: string
  token: string
  /** Optional: override session id. */
  sessionKey?: string
  /** Path the PCM worklet is served at. Default: `/pcm-worklet.js`. */
  workletUrl?: string
  /** Override base_input passed to the flow on session.open. */
  baseInput?: Record<string, unknown>
}

export class VoiceSession {
  private emitter = new Emitter<VoiceEventMap>()
  private opts: VoiceSessionOptions
  private sessionKey: string
  private stream: WebhookStreamSession
  private audioWs: WebSocket | null = null
  private mic: { stop: () => Promise<void>; isActive: () => boolean } | null = null
  private tts: TtsPlayer | null = null
  private transport: 'binary' | 'text-b64' = 'binary'
  private startedAt = 0
  private stopped = false

  constructor(opts: VoiceSessionOptions) {
    this.opts = opts
    this.sessionKey = opts.sessionKey ?? randomSessionId('voice')
    this.stream = new WebhookStreamSession({
      apiUrl: opts.apiUrl,
      webhookId: opts.webhookId,
      token: opts.token,
      sessionKey: this.sessionKey,
      baseInput: opts.baseInput,
      autoReconnect: false,
    })
    this.wireStreamEvents()
  }

  /** The session key in use. Useful for diagnostics / "session: web-xxxx" UI. */
  getSessionKey(): string {
    return this.sessionKey
  }

  on<K extends keyof VoiceEventMap>(event: K, listener: Listener<VoiceEventMap[K]>): () => void {
    return this.emitter.on(event, listener)
  }

  off<K extends keyof VoiceEventMap>(event: K, listener: Listener<VoiceEventMap[K]>): void {
    this.emitter.off(event, listener)
  }

  /**
   * Open every transport (events WS, audio WS, mic) and start streaming.
   * Resolves once the audio WS is ready; `voice.ready` fires at the same
   * point. Throws on permission denial / transport failure.
   */
  async start(): Promise<void> {
    if (this.stopped) throw new Error('voice session already stopped')
    this.startedAt = Date.now()
    this.tts = createTtsPlayer({
      onUrl: (url) => this.emitter.emit('tts.url', { url }),
      onError: (err) => this.emitter.emit('tts.error', { error: err.message }),
    })

    // 1) Events WS — handshake completes via WebhookStreamSession; we then
    //    send `session.open` to trigger the streaming flow start without
    //    waiting for an inbound message (voice flows have no first text).
    await this.connectEventsWs()

    // 2) Audio WS — receives the mic frames. Server replies with `ready`
    //    on auth success and `ack` per-frame.
    this.transport = pickAudioWsTransport()
    await this.connectAudioWs()

    // 3) Mic capture — starts feeding the audio WS.
    this.mic = await startMicCapture({
      workletUrl: this.opts.workletUrl,
      onFrame: (buf) => this.sendAudioFrame(buf),
      onLevel: (rms) => this.emitter.emit('mic.level', { rms }),
    })

    this.emitter.emit('voice.ready', {})
  }

  /** Tear down the session. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true

    if (this.mic) {
      await this.mic.stop().catch(() => {})
      this.mic = null
    }
    if (this.audioWs) {
      try {
        if (this.audioWs.readyState === WebSocket.OPEN) {
          this.audioWs.send(JSON.stringify({ type: 'end' }))
        }
        this.audioWs.close()
      } catch {
        // already closing.
      }
      this.audioWs = null
    }
    this.stream.close()
    this.tts?.destroy()
    this.tts = null
    this.emitter.emit('voice.stopped', {
      elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
    })
    this.emitter.removeAll()
  }

  private async connectEventsWs(): Promise<void> {
    return new Promise((resolve, reject) => {
      const offReady = this.stream.on('ready', () => {
        offReady()
        // session.start is sent automatically by WebhookStreamSession on `ready`.
        // We additionally need `session.open` to kick off a stream-trigger flow.
        // Defer one tick so the stream session has dispatched session.start
        // before we layer session.open on top.
        setTimeout(() => {
          this.stream.sendRaw({ type: 'session.open', base_input: this.opts.baseInput })
          resolve()
        }, 50)
      })
      const offError = this.stream.on('error', ({ message }) => {
        offError()
        reject(new Error(`events ws: ${message}`))
      })
      this.stream.connect()
    })
  }

  private async connectAudioWs(): Promise<void> {
    const url = toWsUrl(this.opts.apiUrl, `/v1/audio/${this.sessionKey}`, {
      token: this.opts.token,
      codec: 'pcm16',
      sr: '16000',
    })
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(appendClientQueryParams(url))
      ws.binaryType = 'arraybuffer'
      this.audioWs = ws
      let resolved = false

      // Wait for the server-sent `ready` frame before resolving — the
      // socket is open but auth hasn't run yet.
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string') return
        try {
          const frame = JSON.parse(ev.data) as { type?: string; message?: string }
          if (frame.type === 'ready' && !resolved) {
            resolved = true
            resolve()
          } else if (frame.type === 'error' && !resolved) {
            resolved = true
            reject(new Error(frame.message ?? 'audio ws error'))
          }
        } catch {
          // ignore non-json frames.
        }
      })
      ws.addEventListener('error', () => {
        if (resolved) return
        resolved = true
        reject(new Error('audio ws transport error'))
      })
      ws.addEventListener('close', (ev) => {
        if (resolved) return
        resolved = true
        reject(new Error(`audio ws closed code=${ev.code}`))
      })
    })
  }

  private sendAudioFrame(buf: ArrayBuffer): void {
    if (!this.audioWs || this.audioWs.readyState !== WebSocket.OPEN) return
    if (this.transport === 'binary') {
      this.audioWs.send(buf)
      return
    }
    this.audioWs.send(
      JSON.stringify({
        type: 'audio',
        data_b64: arrayBufferToBase64(buf),
      }),
    )
  }

  private wireStreamEvents(): void {
    // Forward every event from the stream session 1:1, then layer
    // voice-specific parsing on top of the `node.emit` channel.
    this.stream.on('ready', (e) => this.emitter.emit('ready', e))
    this.stream.on('closed', (e) => this.emitter.emit('closed', e))
    this.stream.on('node.started', (e) => this.emitter.emit('node.started', e))
    this.stream.on('node.completed', (e) => this.emitter.emit('node.completed', e))
    this.stream.on('node.failed', (e) => this.emitter.emit('node.failed', e))
    this.stream.on('node.token', (e) => {
      this.emitter.emit('node.token', e)
      // STT partials come through node.token on the recogniser node.
      // Promote to transcript.partial when nodeId looks like a recogniser
      // — keep node.token broadcasting too so generation streams still work.
      if (e.nodeId !== 'tutor') this.emitter.emit('transcript.partial', { text: e.text })
    })
    this.stream.on('flow.completed', (e) => this.emitter.emit('flow.completed', e))
    this.stream.on('flow.failed', (e) => this.emitter.emit('flow.failed', e))
    this.stream.on('error', (e) => this.emitter.emit('error', e))
    this.stream.on('node.emit', (e) => {
      this.emitter.emit('node.emit', e)
      this.handleVoiceEmit(e.kind, e.data)
    })
  }

  private handleVoiceEmit(kind: string, data: Record<string, unknown>): void {
    if (kind === 'transcript.final') {
      const text = typeof data.text === 'string' ? data.text : ''
      if (text) this.emitter.emit('transcript.final', { text })
      return
    }
    if (kind === 'transcript.error') {
      this.emitter.emit('transcript.error', { error: String(data.error ?? 'unknown') })
      return
    }
    if (kind === 'tts.chunk') {
      const b64 = typeof data.data_b64 === 'string' ? data.data_b64 : ''
      const index = typeof data.index === 'number' ? data.index : 0
      const sampleRate = typeof data.sample_rate === 'number' ? data.sample_rate : 24_000
      const format = data.format === 'pcm' ? 'pcm' : 'mp3'
      if (!b64) return
      const bytes = base64ToBytes(b64)
      this.tts?.push(format, sampleRate, bytes)
      this.emitter.emit('tts.chunk', { bytes: bytes.byteLength, index })
      return
    }
    if (kind === 'tts.done') {
      const totalBytes = typeof data.total_bytes === 'number' ? data.total_bytes : 0
      this.tts?.end(totalBytes)
      this.emitter.emit('tts.done', { totalBytes })
      return
    }
    if (kind === 'tts.error') {
      this.emitter.emit('tts.error', { error: String(data.error ?? 'unknown') })
    }
  }
}
