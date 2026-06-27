/**
 * Mic capture pipeline. Hooks `getUserMedia` → `AudioWorklet` → 16kHz
 * PCM16 frames → caller-supplied `onFrame(buf)` callback.
 *
 * Mobile-Chrome quirk worth keeping in mind: if the audio graph has no
 * path to `audioCtx.destination`, Chrome on Android stops pulling samples
 * from the mic ("inaudible graph" optimisation). Routing the worklet
 * through a Gain(0) → destination keeps the graph live without echoing
 * the mic to the speakers.
 *
 * The integrator must serve the worklet as `/pcm-worklet.js` (defaults to
 * `pcm-downsampler` processor). Pass `workletUrl` to override. The SDK
 * ships the worklet source as a static asset under `voice/pcm-worklet.js`
 * — copy it to your public/ folder.
 *
 * Browser-only — `getUserMedia` and `AudioWorklet` don't exist in Node.
 */

export interface MicCaptureOptions {
  /** Called with each 16kHz mono PCM16 frame the worklet emits. */
  onFrame: (buffer: ArrayBuffer) => void
  /** Optional level reports (RMS 0..1) for "is the user speaking" UI. */
  onLevel?: (rms: number) => void
  /** Path the worklet module is served at. Defaults to the SDK's inlined Blob. */
  workletUrl?: string
  /**
   * Use this MediaStream instead of calling `getUserMedia`. For apps that
   * already own a processed stream (e.g. a Web Audio mixer injecting test
   * audio, or a custom constraints set). The caller owns its lifecycle — we
   * don't stop its tracks on `stop()`.
   */
  mediaStream?: MediaStream
}

export interface MicCaptureHandle {
  stop: () => Promise<void>
  isActive: () => boolean
}

/**
 * Open the mic and start emitting frames. Throws on permission denial
 * or if the worklet module fails to load — the caller should treat that
 * as a fatal session error.
 */
export async function startMicCapture(opts: MicCaptureOptions): Promise<MicCaptureHandle> {
  // Default to the inlined worklet (a Blob URL) so consuming apps don't have to
  // copy `pcm-worklet.js` into their public dir — the SDK is self-contained.
  // An explicit `workletUrl` still wins (e.g. a CSP that forbids blob: workers).
  const workletUrl = opts.workletUrl ?? defaultWorkletUrl()
  // A caller-provided stream (mixer/custom constraints) takes over; otherwise
  // open the mic ourselves. `ownsStream` decides whether stop() tears it down.
  const ownsStream = !opts.mediaStream
  const mediaStream =
    opts.mediaStream ??
    (await navigator.mediaDevices.getUserMedia({ audio: buildMicConstraints() }))

  const Ctor = (window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext) as typeof AudioContext
  const audioCtx = new Ctor()
  if (audioCtx.state === 'suspended') await audioCtx.resume()

  try {
    await audioCtx.audioWorklet.addModule(workletUrl)
  } catch (err) {
    mediaStream.getTracks().forEach((t) => t.stop())
    await audioCtx.close().catch(() => {})
    throw new Error(
      `failed to load worklet at ${workletUrl}: ${err instanceof Error ? err.message : 'unknown'}`,
    )
  }

  const source = audioCtx.createMediaStreamSource(mediaStream)
  const workletNode = new AudioWorkletNode(audioCtx, 'pcm-downsampler', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { targetSampleRate: 16_000 },
  })
  // The Gain(0) → destination path is the mobile-Chrome workaround
  // documented above. Don't remove without retesting on Android.
  const silentSink = audioCtx.createGain()
  silentSink.gain.value = 0
  workletNode.connect(silentSink)
  silentSink.connect(audioCtx.destination)

  let stopped = false

  workletNode.port.onmessage = (ev: MessageEvent) => {
    if (stopped) return
    const data = ev.data
    if (data && typeof data === 'object' && 'type' in data) {
      const typed = data as { type: string; rms?: number }
      if (typed.type === 'level' && typeof typed.rms === 'number') {
        opts.onLevel?.(typed.rms)
        return
      }
    }
    if (data instanceof ArrayBuffer) opts.onFrame(data)
  }

  source.connect(workletNode)

  const stop = async () => {
    if (stopped) return
    stopped = true
    try {
      workletNode.disconnect()
    } catch {
      // already disconnected.
    }
    // Only stop tracks we opened — a caller-provided stream stays alive.
    if (ownsStream) mediaStream.getTracks().forEach((t) => t.stop())
    await audioCtx.close().catch(() => {})
  }

  return {
    stop,
    isActive: () => !stopped,
  }
}

function buildMicConstraints(): MediaTrackConstraints {
  const supported =
    typeof navigator !== 'undefined' && navigator.mediaDevices?.getSupportedConstraints
      ? navigator.mediaDevices.getSupportedConstraints()
      : {}
  const audio: MediaTrackConstraints = { channelCount: 1 }
  // Voice agents do their own VAD/STT — leave the raw signal untouched so
  // upstream models aren't fighting the browser's processing.
  if (supported.echoCancellation) audio.echoCancellation = false
  if (supported.noiseSuppression) audio.noiseSuppression = false
  if (supported.autoGainControl) audio.autoGainControl = false
  return audio
}

/**
 * Some Android Chromes drop binary frames silently when the page transitions
 * to a Service Worker. Falling back to base64-over-text keeps audio flowing
 * on those devices.
 */
export function pickAudioWsTransport(): 'binary' | 'text-b64' {
  const nav = typeof navigator !== 'undefined' ? navigator : null
  if (!nav) return 'binary'
  const uaData = nav as Navigator & { userAgentData?: { mobile?: boolean } }
  if (uaData.userAgentData?.mobile) return 'text-b64'
  if (/Android|iPhone|iPad|iPod/i.test(nav.userAgent)) return 'text-b64'
  return 'binary'
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

// Cached Blob URL for the inlined worklet. Built lazily on first mic capture.
let cachedWorkletUrl: string | null = null

function defaultWorkletUrl(): string {
  if (cachedWorkletUrl) return cachedWorkletUrl
  const blob = new Blob([WORKLET_SOURCE], { type: 'text/javascript' })
  cachedWorkletUrl = URL.createObjectURL(blob)
  return cachedWorkletUrl
}

/**
 * PCM16 downsampler worklet, inlined so the SDK ships self-contained (no
 * `public/pcm-worklet.js` for apps to copy). Receives Float32 mic samples at
 * the native rate, downsamples to 16 kHz, converts to Int16-LE, and posts the
 * ArrayBuffer to the main thread. Keep in sync with `assets/pcm-worklet.js`.
 */
const WORKLET_SOURCE = `
class PcmDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const params = (options && options.processorOptions) || {}
    this.targetSampleRate = params.targetSampleRate || 16000
    this.buffer = []
    this.bufferLength = 0
    this.chunkSamplesIn = Math.round(sampleRate * 0.1)
  }
  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0]) return true
    const channel0 = input[0]
    const channel1 = input.length > 1 ? input[1] : null
    const mono = new Float32Array(channel0.length)
    for (let i = 0; i < channel0.length; i += 1) {
      mono[i] = channel1 ? (channel0[i] + channel1[i]) * 0.5 : channel0[i]
    }
    this.buffer.push(mono)
    this.bufferLength += mono.length
    while (this.bufferLength >= this.chunkSamplesIn) {
      const chunk = this.consumeChunk(this.chunkSamplesIn)
      const down = downsampleLinear(chunk, sampleRate, this.targetSampleRate)
      const pcm = floatToInt16(down)
      this.port.postMessage(pcm.buffer, [pcm.buffer])
    }
    return true
  }
  consumeChunk(samples) {
    const out = new Float32Array(samples)
    let written = 0
    while (written < samples && this.buffer.length > 0) {
      const head = this.buffer[0]
      const take = Math.min(samples - written, head.length)
      out.set(head.subarray(0, take), written)
      written += take
      if (take === head.length) this.buffer.shift()
      else this.buffer[0] = head.subarray(take)
    }
    this.bufferLength -= samples
    return out
  }
}
function downsampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input
  const ratio = fromRate / toRate
  const outLength = Math.floor(input.length / ratio)
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i += 1) {
    const srcIndex = i * ratio
    const base = Math.floor(srcIndex)
    const frac = srcIndex - base
    const a = input[base] || 0
    const b = input[base + 1] !== undefined ? input[base + 1] : a
    out[i] = a + (b - a) * frac
  }
  return out
}
function floatToInt16(f32) {
  const i16 = new Int16Array(f32.length)
  for (let i = 0; i < f32.length; i += 1) {
    let s = f32[i]
    if (s > 1) s = 1
    else if (s < -1) s = -1
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return i16
}
registerProcessor('pcm-downsampler', PcmDownsampler)
`
