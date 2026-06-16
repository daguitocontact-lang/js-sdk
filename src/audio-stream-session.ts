/**
 * Audio-only upstream WebSocket session — mirrors the Python and Go SDKs.
 *
 * Opens `wss://<api>/v1/audio/<session_id>?token=…&codec=…&sr=…`, blocks on
 * a `ready` JSON frame from the server, then accepts raw binary chunks via
 * `sendAudio(chunk)`. The server XADDs each chunk to the Redis stream
 * `audio:<session_key>`; the flow's `a_transcribe_stream` node pipes those
 * frames into the configured STT provider.
 *
 * This session does NOT carry transcript / flow events back. For those,
 * open a companion `WebhookStreamSession` on the same `session_id`.
 *
 * Browser + Node 18+. In Node we rely on the global `WebSocket` (Node 22)
 * or a polyfill the caller installs; we don't pull `ws` as a dep.
 */
import { joinHttp } from './url'
import {
  appendClientQueryParams,
  clientQueryParams,
} from './internal/client-headers'

export class AudioStreamError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AudioStreamError'
  }
}

export const SUPPORTED_AUDIO_CODECS = [
  'pcm16',
  'opus',
  'webm-opus',
  'mulaw',
  'flac',
] as const
export type AudioCodec = (typeof SUPPORTED_AUDIO_CODECS)[number]

export interface AudioStreamOptions {
  apiUrl: string
  token: string
  /** Conversation id — pass the same one to a companion event session. */
  sessionId?: string
  /** Defaults to `pcm16`. */
  codec?: AudioCodec
  /** Required when codec='pcm16'. */
  sampleRate?: number
  /** Defaults to 10 000 ms. */
  readyTimeoutMs?: number
  /** Optional override for tests / custom runtimes. */
  webSocketImpl?: typeof WebSocket
  /**
   * Re-open the socket transparently on unexpected drops. Default `true`.
   * Reuses the same sessionId so server-side XADDs keep landing on the
   * same Redis stream key — the flow's `a_transcribe_stream` node consumes
   * across the seam without noticing.
   */
  autoReconnect?: boolean
}

export interface AudioStreamReady {
  sessionKey: string
  codec: string
  guards: Record<string, unknown>
}

function randomSessionId(): string {
  // Lightweight: 12 random bytes → 16-char URL-safe id. Sufficient for an
  // audio session id; the server treats it as opaque.
  const buf = new Uint8Array(12)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(buf)
  } else {
    for (let i = 0; i < buf.length; i += 1) buf[i] = Math.floor(Math.random() * 256)
  }
  let s = ''
  for (const b of buf) s += b.toString(16).padStart(2, '0')
  return `js_${s.slice(0, 16)}`
}

function toWsUrl(apiUrl: string, path: string, query: Record<string, string>): string {
  const u = new URL(joinHttp(apiUrl, path))
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v)
  for (const [k, v] of Object.entries(clientQueryParams())) u.searchParams.set(k, v)
  return u.toString()
}

export class AudioStreamSession {
  private readonly opts: Required<
    Pick<AudioStreamOptions, 'apiUrl' | 'token' | 'codec' | 'readyTimeoutMs'>
  > & {
    sessionId: string
    sampleRate?: number
    webSocketImpl: typeof WebSocket
    autoReconnect: boolean
  }
  private socket: WebSocket | null = null
  private _ready: AudioStreamReady | null = null
  private readonly errors: string[] = []
  private connectPromise: Promise<void> | null = null
  private closed = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: AudioStreamOptions) {
    const codec = opts.codec ?? 'pcm16'
    if (!(SUPPORTED_AUDIO_CODECS as readonly string[]).includes(codec)) {
      throw new AudioStreamError(
        `unsupported codec ${codec}; expected one of ${SUPPORTED_AUDIO_CODECS.join(', ')}`,
      )
    }
    if (codec === 'pcm16' && (opts.sampleRate === undefined || opts.sampleRate <= 0)) {
      throw new AudioStreamError('sampleRate is required when codec=\"pcm16\"')
    }
    const WS = opts.webSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
    if (!WS) {
      throw new AudioStreamError(
        'no WebSocket implementation available; pass `webSocketImpl` in options',
      )
    }
    this.opts = {
      apiUrl: opts.apiUrl,
      token: opts.token,
      codec,
      sampleRate: opts.sampleRate,
      sessionId: opts.sessionId ?? randomSessionId(),
      readyTimeoutMs: opts.readyTimeoutMs ?? 10_000,
      webSocketImpl: WS,
      autoReconnect: opts.autoReconnect ?? true,
    }
  }

  get sessionId(): string {
    return this.opts.sessionId
  }

  get ready(): AudioStreamReady | null {
    return this._ready
  }

  async connect(): Promise<void> {
    if (this.closed) throw new AudioStreamError('session is closed')
    if (this.socket) return
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = this.openAndHandshake()
    try {
      await this.connectPromise
    } finally {
      this.connectPromise = null
    }
  }

  private openAndHandshake(): Promise<void> {
    return new Promise((resolve, reject) => {
      const query: Record<string, string> = {
        token: this.opts.token,
        codec: this.opts.codec,
      }
      if (this.opts.sampleRate !== undefined) {
        query.sr = String(this.opts.sampleRate)
      }
      const url = appendClientQueryParams(
        toWsUrl(this.opts.apiUrl, `/v1/audio/${this.opts.sessionId}`, query),
      )
      const WS = this.opts.webSocketImpl
      const socket = new WS(url)
      socket.binaryType = 'arraybuffer'
      this.socket = socket

      let settled = false
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          socket.close()
        } catch {
          // ignore
        }
        reject(
          new AudioStreamError(
            `timed out waiting for ready frame after ${this.opts.readyTimeoutMs}ms`,
          ),
        )
      }, this.opts.readyTimeoutMs)

      const settle = (err: AudioStreamError | null) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (err) reject(err)
        else resolve()
      }

      socket.onmessage = (evt: MessageEvent) => {
        const raw = evt.data
        if (typeof raw !== 'string') return
        let payload: Record<string, unknown>
        try {
          payload = JSON.parse(raw) as Record<string, unknown>
        } catch {
          return
        }
        const t = typeof payload.type === 'string' ? payload.type : ''
        if (t === 'ready') {
          this._ready = {
            sessionKey: typeof payload.session_key === 'string' ? payload.session_key : '',
            codec: typeof payload.codec === 'string' ? payload.codec : this.opts.codec,
            guards:
              payload.guards && typeof payload.guards === 'object'
                ? (payload.guards as Record<string, unknown>)
                : {},
          }
          settle(null)
          return
        }
        if (t === 'error') {
          const msg = typeof payload.message === 'string' ? payload.message : 'server error'
          this.errors.push(msg)
          if (!this._ready) {
            settle(new AudioStreamError(`server rejected audio session: ${msg}`))
          }
        }
      }

      socket.onerror = () => {
        settle(new AudioStreamError('websocket error during audio handshake'))
      }

      socket.onclose = () => {
        if (!this._ready) {
          settle(new AudioStreamError('socket closed before ready frame'))
          return
        }
        // Dropped after a successful handshake — try to bring the socket
        // back without surfacing the close to the caller. Same sessionId
        // keeps the server-side Redis stream key consistent.
        if (this.socket === socket) this.socket = null
        if (!this.closed && this.opts.autoReconnect) this.scheduleReconnect()
      }
    })
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    this.reconnectAttempt += 1
    const delayMs = Math.min(30_000, 1_000 * 2 ** (this.reconnectAttempt - 1))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.closed) return
      // Drop the stale ready snapshot so a new handshake re-fills it.
      this._ready = null
      this.connect()
        .then(() => {
          this.reconnectAttempt = 0
        })
        .catch(() => {
          // openAndHandshake's reject path is already wired; if it failed,
          // its socket.onclose will run scheduleReconnect again.
        })
    }, delayMs)
  }

  async sendAudio(chunk: ArrayBuffer | Uint8Array): Promise<void> {
    if (this.closed) throw new AudioStreamError('session is closed')
    // Mid-reconnect: drop the chunk instead of throwing so the caller's
    // mic-pump loop survives the outage. By the time the reconnect lands,
    // the buffered audio would be stale anyway.
    if (this.opts.autoReconnect && (!this.socket || !this._ready || this.socket.readyState !== 1)) {
      return
    }
    if (!this.socket) throw new AudioStreamError('not connected (call connect() first)')
    if (!this._ready) throw new AudioStreamError('handshake not complete')
    if (this.socket.readyState !== 1 /* OPEN */) {
      throw new AudioStreamError(`socket not open (readyState=${this.socket.readyState})`)
    }
    // Copy into a fresh ArrayBuffer when the input is a typed array view —
    // `socket.send` accepts ArrayBuffer; SharedArrayBuffer (which
    // `Uint8Array.buffer` may be) is not allowed by some browsers.
    if (chunk instanceof ArrayBuffer) {
      this.socket.send(chunk)
      return
    }
    const copy = new Uint8Array(chunk.byteLength)
    copy.set(chunk)
    this.socket.send(copy.buffer)
  }

  /**
   * Send a text control frame on the audio socket. `pause` ends the live STT
   * segment server-side (the provider socket closes so it stops billing);
   * `resume` opens a fresh one — without tearing the session down. Lets a long
   * consultation pause/resume on the same run.
   */
  async sendControl(control: 'pause' | 'resume'): Promise<void> {
    if (this.closed) throw new AudioStreamError('session is closed')
    if (!this.socket) throw new AudioStreamError('not connected (call connect() first)')
    if (!this._ready) throw new AudioStreamError('handshake not complete')
    if (this.socket.readyState !== 1 /* OPEN */) {
      throw new AudioStreamError(`socket not open (readyState=${this.socket.readyState})`)
    }
    this.socket.send(control)
  }

  pause(): Promise<void> {
    return this.sendControl('pause')
  }

  resume(): Promise<void> {
    return this.sendControl('resume')
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.socket) {
      try {
        this.socket.close()
      } catch {
        // ignore
      }
      this.socket = null
    }
  }
}
