/**
 * @daguito/sdk/voice — browser-only voice agent surface.
 *
 * Uses `getUserMedia`, `AudioWorklet`, and `MediaSource`. Importing this
 * entry from Node will fail at runtime when these globals are accessed.
 *
 * Quick start:
 *   import { VoiceSession } from '@daguito/sdk/voice'
 *
 *   const voice = new VoiceSession({ apiUrl, webhookId, token })
 *   voice.on('transcript.partial', ({ text }) => showLive(text))
 *   voice.on('transcript.final', ({ text }) => append(text))
 *   voice.on('tts.url', ({ url }) => { audioEl.src = url })
 *   voice.on('node.token', ({ text }) => append(text))
 *   await voice.start()
 *   // ...
 *   await voice.stop()
 *
 * The integrator must serve the PCM worklet at `/pcm-worklet.js`
 * (or pass `workletUrl` to override). Worklet source ships in this
 * package under `voice/pcm-worklet.js`.
 */

export { VoiceSession } from './voice-session'
export type { VoiceSessionOptions, VoiceEventMap } from './voice-session'

export { startMicCapture, pickAudioWsTransport } from './mic-capture'
export type { MicCaptureOptions, MicCaptureHandle } from './mic-capture'

export { createTtsPlayer, base64ToBytes } from './tts-player'
export type { TtsPlayer, TtsPlayerOptions, TtsFormat } from './tts-player'
