import { MicStream, type MicStreamOptions } from './mic-stream'
import { OutputStream } from '../output-stream'

/**
 * Transcription — live speech-to-text into a text field (a chat composer, a
 * note, a search box). Streams the mic to a Daguito transcribe-only flow and
 * surfaces the transcript so the field can be filled by voice (dictation).
 *
 * Unlike `VoiceSession` it never plays TTS and never drives an agent — it ONLY
 * transcribes, so dictating into a chatbot composer never triggers a reply. The
 * user reviews/edits the text and sends it themselves.
 *
 * Bundles `MicStream` (mic → 16 kHz PCM → audio WS, VAD-gated so the STT
 * provider only runs while you actually speak) and `OutputStream` (the
 * transcript events). Bind the assembled draft straight to an input:
 *
 *   const transcription = new Transcription({
 *     apiUrl, webhookId, token, sessionId,
 *     onText: (draft) => setInput(draft),   // committed finals + live interim
 *   })
 *   await transcription.start()   // mic permission + sockets
 *   // user speaks → onText fires with growing text
 *   const finalText = await transcription.stop()
 *
 * `token` is a `dst_` BIDI stream token (produce audio + consume transcript)
 * scoped to the transcribe flow's session. Browser-only (depends on MicStream's
 * `getUserMedia` + `AudioWorklet`).
 */
export interface TranscriptionOptions {
  apiUrl: string
  webhookId: string
  /** A `dst_` bidi token, or the webhook secret on a trusted surface. */
  token: string
  /** Shared rendezvous id for this transcription session. */
  sessionId: string
  /** Assembled draft (committed finals + live interim) on every change — the
   *  simplest binding for a text input. */
  onText?: (draft: string) => void
  /** A finalized utterance, appended to the committed text. */
  onFinal?: (text: string) => void
  /** The live interim hypothesis, replaced as the speaker keeps talking. */
  onPartial?: (text: string) => void
  /** Mic level 0..1 (RMS) for a "listening" VU meter. */
  onLevel?: (rms: number) => void
  onError?: (err: Error) => void
  /** VAD config. Defaults to enabled so the transcriber idles in silence; pass
   *  `false` to stream continuously. */
  vad?: MicStreamOptions['vad'] | false
  /** Stream a caller-owned MediaStream instead of opening the mic ourselves. */
  mediaStream?: MediaStream
}

export class Transcription {
  private readonly opts: TranscriptionOptions
  private mic: MicStream | null = null
  private out: OutputStream | null = null
  private readonly finals: string[] = []
  private interim = ''
  private stopped = false

  constructor(opts: TranscriptionOptions) {
    this.opts = opts
  }

  /** Whether the mic is currently open and streaming. */
  get active(): boolean {
    return this.mic !== null
  }

  /** Committed text so far (finals only — excludes the live interim). */
  get text(): string {
    return this.finals.join(' ').replace(/\s+/g, ' ').trim()
  }

  /** Committed + live interim — what a draft input should show. */
  get draft(): string {
    return [...this.finals, this.interim]
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  /** Open the transcript socket + mic and start transcribing. Idempotent. */
  async start(): Promise<void> {
    if (this.stopped) throw new Error('Transcription is stopped — create a new instance')
    if (this.mic) return

    const out = new OutputStream({
      apiUrl: this.opts.apiUrl,
      webhookId: this.opts.webhookId,
      token: this.opts.token,
      sessionKey: this.opts.sessionId,
    })
    // Partial (interim) transcript arrives as node.token; a finalized utterance
    // as node.emit { kind: 'transcript.final' }. A transcribe-only flow emits
    // nothing else, so no node-id filtering is needed.
    out.on('node.token', ({ text }) => this.applyInterim(text))
    out.on('node.emit', ({ kind, data }) => {
      if (kind !== 'transcript.final') return
      const text = typeof data.text === 'string' ? data.text : ''
      if (text.trim().length > 0) this.commit(text)
    })
    out.on('error', ({ message }) => this.opts.onError?.(new Error(message)))
    this.out = out

    const vad = this.opts.vad === false ? undefined : (this.opts.vad ?? { enabled: true })
    const mic = new MicStream({
      apiUrl: this.opts.apiUrl,
      token: this.opts.token,
      sessionId: this.opts.sessionId,
      mediaStream: this.opts.mediaStream,
      onLevel: this.opts.onLevel,
      onError: (e) => this.opts.onError?.(e),
      vad,
    })
    this.mic = mic
    try {
      await mic.start()
    } catch (err) {
      await this.stop()
      throw err
    }
  }

  /** Stop the mic + sockets and return the committed transcript. Idempotent. */
  async stop(): Promise<string> {
    this.stopped = true
    const mic = this.mic
    this.mic = null
    if (mic) await mic.stop().catch(() => {})
    this.out?.close()
    this.out = null
    return this.text
  }

  private applyInterim(text: string): void {
    this.interim = text
    this.opts.onPartial?.(text)
    this.opts.onText?.(this.draft)
  }

  private commit(text: string): void {
    this.finals.push(text)
    this.interim = ''
    this.opts.onFinal?.(text)
    this.opts.onText?.(this.draft)
  }
}
