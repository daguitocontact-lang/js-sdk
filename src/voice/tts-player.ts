/**
 * Streaming TTS player. The server emits `tts.chunk` (base64) frames with
 * `format ∈ {mp3, pcm}` and a `sample_rate` for PCM. We surface a single
 * blob URL per utterance that the integrator can attach to an `<audio>`
 * element — the URL becomes playable as soon as the first chunk arrives.
 *
 * mp3: MediaSource Extensions (MSE) — browsers natively decode mp3 frames
 *      progressively, so playback starts ms after the first chunk lands.
 * pcm: collected to a single WAV blob at end-of-stream. PCM is not
 *      progressively playable in browsers, so it falls back to "wait for
 *      tts.done, then play". Server defaults to mp3 for this reason.
 *
 * Browser-only — MediaSource doesn't exist in Node.
 */

export type TtsFormat = 'mp3' | 'pcm'

export interface TtsPlayer {
  /** Push a decoded chunk. Triggers a URL emit on the first chunk. */
  push(format: TtsFormat, sampleRate: number, bytes: Uint8Array): void
  /** Server signalled end-of-utterance — finalise PCM/MSE buffers. */
  end(totalBytes: number): void
  /** Tear down. Revokes object URLs. */
  destroy(): void
}

export interface TtsPlayerOptions {
  /**
   * Fired the first time we have a playable URL for the active utterance.
   * For mp3 this fires synchronously on the first chunk; for PCM it fires
   * on `end()`.
   */
  onUrl: (url: string) => void
  onError?: (err: Error) => void
}

export function createTtsPlayer(opts: TtsPlayerOptions): TtsPlayer {
  let mp3: Mp3StreamPlayer | null = null
  let pcm: PcmCollector | null = null

  return {
    push(format, sampleRate, bytes) {
      if (format === 'mp3') {
        if (!mp3) {
          mp3 = new Mp3StreamPlayer()
          opts.onUrl(mp3.url)
        }
        try {
          mp3.push(bytes)
        } catch (err) {
          opts.onError?.(err as Error)
        }
        return
      }
      if (!pcm) pcm = new PcmCollector(sampleRate || 24_000)
      pcm.push(bytes)
    },

    end() {
      if (mp3) {
        const closing = mp3
        mp3 = null
        closing.end()
        // Revoke later so the <audio> element can finish playback.
        setTimeout(() => closing.destroy(), 5_000)
        return
      }
      if (pcm) {
        const blob = pcm.buildWav()
        pcm = null
        if (blob) {
          const url = URL.createObjectURL(blob)
          opts.onUrl(url)
        }
      }
    },

    destroy() {
      if (mp3) {
        const closing = mp3
        mp3 = null
        try {
          closing.destroy()
        } catch (err) {
          opts.onError?.(err as Error)
        }
      }
      pcm = null
    },
  }
}

/**
 * Progressive mp3 player backed by MediaSource Extensions. Each incoming
 * chunk is an already-playable mp3 frame; we feed them to a SourceBuffer
 * with `mode: 'sequence'` so the browser handles buffering, resampling
 * and timestamps. Battle-tested in the english-tutor demo.
 */
class Mp3StreamPlayer {
  readonly url: string
  private ms: MediaSource
  private sbP: Promise<SourceBuffer>
  private pending: Uint8Array[] = []
  private appending = false
  private ended = false

  constructor() {
    this.ms = new MediaSource()
    this.url = URL.createObjectURL(this.ms)
    this.sbP = new Promise<SourceBuffer>((resolve, reject) => {
      const onOpen = () => {
        this.ms.removeEventListener('sourceopen', onOpen)
        try {
          const sb = this.ms.addSourceBuffer('audio/mpeg')
          sb.mode = 'sequence'
          sb.addEventListener('updateend', () => void this.drain())
          resolve(sb)
        } catch (err) {
          reject(err as Error)
        }
      }
      this.ms.addEventListener('sourceopen', onOpen)
    })
  }

  push(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    this.pending.push(copy)
    void this.drain()
  }

  end(): void {
    this.ended = true
    void this.drain()
  }

  destroy(): void {
    this.ended = true
    try {
      if (this.ms.readyState === 'open') this.ms.endOfStream()
    } catch {
      // already ended.
    }
    URL.revokeObjectURL(this.url)
  }

  private async drain(): Promise<void> {
    if (this.appending) return
    let sb: SourceBuffer
    try {
      sb = await this.sbP
    } catch {
      return
    }
    if (sb.updating) return
    const next = this.pending.shift()
    if (!next) {
      if (this.ended && this.ms.readyState === 'open') {
        try {
          this.ms.endOfStream()
        } catch {
          // already ended.
        }
      }
      return
    }
    this.appending = true
    try {
      sb.appendBuffer(next.buffer as ArrayBuffer)
    } catch {
      this.appending = false
      return
    }
    const onDone = () => {
      sb.removeEventListener('updateend', onDone)
      this.appending = false
    }
    sb.addEventListener('updateend', onDone)
  }
}

/**
 * Legacy fallback: if the server ever emits PCM16 instead of mp3, collect
 * all chunks and build a single WAV blob at end. Not progressively playable,
 * but supported transparently so a server-side format swap doesn't break
 * the client.
 */
class PcmCollector {
  private rate: number
  private chunks: Uint8Array[] = []
  private totalBytes = 0

  constructor(sampleRate: number) {
    this.rate = sampleRate
  }

  push(bytes: Uint8Array): void {
    if (bytes.byteLength < 2) return
    this.chunks.push(bytes)
    this.totalBytes += bytes.byteLength
  }

  buildWav(): Blob | null {
    if (this.totalBytes === 0) return null
    const pcm = new Uint8Array(this.totalBytes)
    let offset = 0
    for (const c of this.chunks) {
      pcm.set(c, offset)
      offset += c.byteLength
    }
    return wavBlob(pcm, this.rate, 1)
  }
}

function wavBlob(pcm: Uint8Array, sampleRate: number, channels: number): Blob {
  const bitsPerSample = 16
  const byteRate = sampleRate * channels * (bitsPerSample / 8)
  const blockAlign = channels * (bitsPerSample / 8)
  const dataSize = pcm.byteLength
  const header = new ArrayBuffer(44)
  const v = new DataView(header)
  writeString(v, 0, 'RIFF')
  v.setUint32(4, 36 + dataSize, true)
  writeString(v, 8, 'WAVE')
  writeString(v, 12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, channels, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, byteRate, true)
  v.setUint16(32, blockAlign, true)
  v.setUint16(34, bitsPerSample, true)
  writeString(v, 36, 'data')
  v.setUint32(40, dataSize, true)
  const body = pcm.slice().buffer
  return new Blob([header, body], { type: 'audio/wav' })
}

function writeString(v: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i += 1) v.setUint8(offset + i, s.charCodeAt(i))
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}
