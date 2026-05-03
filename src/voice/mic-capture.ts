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
  /** Path the worklet module is served at. Default: `/pcm-worklet.js`. */
  workletUrl?: string
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
  const workletUrl = opts.workletUrl ?? '/pcm-worklet.js'
  const constraints = buildMicConstraints()
  const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: constraints })

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
    mediaStream.getTracks().forEach((t) => t.stop())
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
