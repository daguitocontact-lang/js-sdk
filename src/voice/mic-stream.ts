import { AudioStreamSession } from '../audio-stream-session'
import { startMicCapture, type MicCaptureHandle } from './mic-capture'

/**
 * MicStream — the one-call way to stream a browser mic INTO a Daguito flow
 * channel. Bundles mic capture (getUserMedia → AudioWorklet → 16 kHz PCM16) and
 * the upstream audio WebSocket so a new app needs zero audio plumbing:
 *
 *   const mic = new MicStream({ apiUrl, token, sessionId })
 *   await mic.start()          // asks mic permission, connects, starts streaming
 *   mic.mute()                 // pause (server ends the STT segment → stops billing)
 *   mic.unmute()               // resume on the same session
 *   await mic.stop()           // releases the mic + closes the socket
 *
 * `token` is a `dst_` produce/bidi stream token (or the webhook secret on a
 * trusted surface); `sessionId` is the shared rendezvous id — pass the SAME one
 * to an `OutputStream` to receive the flow's events. The worklet is inlined in
 * the SDK, so there's nothing to copy into the app's public dir.
 *
 * Browser-only (depends on `getUserMedia` + `AudioWorklet`).
 */

export interface MicStreamOptions {
  apiUrl: string
  /** A `dst_` produce/bidi token, or the webhook secret `sk_wh_...`. */
  token: string
  /** Shared rendezvous id (e.g. a consultation/meeting id). */
  sessionId: string
  /** Optional VU-meter level reports (RMS 0..1). */
  onLevel?: (rms: number) => void
  /** Transport/permission errors. The stream auto-reconnects on drops; this
   *  fires for fatal issues (permission denied, worklet load failure). */
  onError?: (err: Error) => void
  /** Override the worklet URL (defaults to the SDK's inlined Blob URL). */
  workletUrl?: string
  /**
   * Stream a caller-owned MediaStream instead of opening the mic ourselves —
   * e.g. a Web Audio mixer (mic + injected test audio) or custom constraints.
   * The caller owns its lifecycle.
   */
  mediaStream?: MediaStream
  /** Re-open the audio socket on unexpected drops. Default true. */
  autoReconnect?: boolean
  /**
   * Voice-activity gating. When enabled, audio is only sent (and the STT
   * segment only kept open) WHILE there is speech — during silence the segment
   * is paused, so the transcriber (e.g. AssemblyAI) is active only when someone
   * is talking, and an idle run can reach its silence deadline and close.
   * Off by default (sends continuously).
   */
  vad?: {
    enabled?: boolean
    /** RMS (0..1) above which a frame counts as speech. Default 0.012. */
    threshold?: number
    /** Keep streaming this long after the last speech frame, so words/sentence
     *  tails aren't cut and the segment finalizes cleanly. Default 1200ms. */
    hangoverMs?: number
  }
  /** Fires on speech↔silence transitions when `vad.enabled` — for "is talking" UI. */
  onSpeaking?: (speaking: boolean) => void
}

export class MicStream {
  private readonly opts: MicStreamOptions
  private session: AudioStreamSession | null = null
  private mic: MicCaptureHandle | null = null
  private paused = false
  private starting: Promise<void> | null = null
  private stopped = false
  private readonly vad: { threshold: number; hangoverMs: number } | null
  private speaking = true
  private lastSpeechAt = 0

  constructor(opts: MicStreamOptions) {
    this.opts = opts
    this.vad = opts.vad?.enabled
      ? { threshold: opts.vad.threshold ?? 0.012, hangoverMs: opts.vad.hangoverMs ?? 1200 }
      : null
  }

  get sessionId(): string {
    return this.opts.sessionId
  }

  get muted(): boolean {
    return this.paused
  }

  /** Open the mic + audio socket and begin streaming. Idempotent. */
  async start(): Promise<void> {
    if (this.stopped) throw new Error('MicStream is stopped — create a new instance')
    if (this.session) return
    if (this.starting) return this.starting
    this.starting = this.doStart()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  private async doStart(): Promise<void> {
    const session = new AudioStreamSession({
      apiUrl: this.opts.apiUrl,
      token: this.opts.token,
      sessionId: this.opts.sessionId,
      codec: 'pcm16',
      sampleRate: 16_000,
      autoReconnect: this.opts.autoReconnect ?? true,
    })
    try {
      await session.connect()
    } catch (err) {
      this.fail(err)
      throw err
    }
    if (this.stopped) {
      session.close()
      return
    }
    this.session = session

    try {
      this.mic = await startMicCapture({
        workletUrl: this.opts.workletUrl,
        mediaStream: this.opts.mediaStream,
        onLevel: this.opts.onLevel,
        onFrame: (buf) => {
          if (this.stopped) return
          // VAD gate: in silence, pause the STT segment (transcriber idles, no
          // cost) and drop the frame; resume on speech. Independent of `paused`
          // (the manual mute) — both must allow it for audio to flow.
          if (this.vad) this.updateVad(buf)
          // Drop frames while muted or silent so the paused segment stays silent;
          // the audio socket survives so we resume on the same run.
          if (this.paused || !this.speaking) return
          void this.session?.sendAudio(buf).catch(() => {
            /* mid-reconnect drops are expected; the session re-opens itself */
          })
        },
      })
    } catch (err) {
      this.fail(err)
      session.close()
      this.session = null
      throw err
    }
    if (this.stopped) {
      await this.stop()
    }
  }

  /** Pause the stream — ends the STT segment server-side (stops billing). */
  async mute(): Promise<void> {
    if (this.paused) return
    this.paused = true
    await this.session?.pause().catch(() => {})
  }

  /** Resume streaming on the same session. */
  async unmute(): Promise<void> {
    if (!this.paused) return
    this.paused = false
    await this.session?.resume().catch(() => {})
  }

  /** Set muted state directly — convenient for binding to a UI toggle. */
  setMuted(muted: boolean): Promise<void> {
    return muted ? this.mute() : this.unmute()
  }

  async stop(): Promise<void> {
    this.stopped = true
    const mic = this.mic
    this.mic = null
    if (mic) await mic.stop().catch(() => {})
    this.session?.close()
    this.session = null
  }

  // Cheap energy-based VAD over the 16 kHz PCM frames. A `hangoverMs` tail keeps
  // the stream open briefly after speech so trailing words and the segment's
  // finalization aren't cut. Crossing into silence pauses the STT segment; back
  // into speech resumes it — so the transcriber only runs while someone talks.
  private updateVad(buf: ArrayBuffer): void {
    const vad = this.vad
    if (!vad) return
    const rms = rmsOfPcm16(buf)
    const now = Date.now()
    if (rms >= vad.threshold) this.lastSpeechAt = now
    const speaking = now - this.lastSpeechAt <= vad.hangoverMs
    if (speaking === this.speaking) return
    this.speaking = speaking
    if (speaking) {
      if (!this.paused) void this.session?.resume().catch(() => {})
    } else {
      void this.session?.pause().catch(() => {})
    }
    this.opts.onSpeaking?.(speaking)
  }

  private fail(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err))
    this.opts.onError?.(e)
  }
}

/** RMS (0..1) of a 16-bit little-endian PCM frame — the VAD energy measure. */
function rmsOfPcm16(buf: ArrayBuffer): number {
  const i16 = new Int16Array(buf)
  if (i16.length === 0) return 0
  let sum = 0
  for (let i = 0; i < i16.length; i += 1) {
    const s = (i16[i] ?? 0) / 0x8000
    sum += s * s
  }
  return Math.sqrt(sum / i16.length)
}
