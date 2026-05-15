/**
 * @daguito/sdk — public TypeScript SDK for the Daguito conversational AI
 * platform. Universal entry point: works in browser AND Node 18+.
 *
 * For voice (mic capture + TTS streaming) import the browser-only
 * `@daguito/sdk/voice` subentry instead — it depends on `getUserMedia`,
 * `AudioWorklet` and `MediaSource`, which don't exist in Node.
 *
 * Quick start:
 *   import { runWebhook, WebhookStreamSession, WidgetSession } from '@daguito/sdk'
 *
 *   // One-shot HTTP webhook
 *   const result = await runWebhook({ apiUrl, token, input: { ... } })
 *
 *   // Streaming WS webhook
 *   const session = new WebhookStreamSession({ apiUrl, webhookId, token })
 *   session.on('node.token', ({ text }) => append(text))
 *   session.on('flow.completed', () => done())
 *   session.send({ kind: 'text', text: 'hola' })
 *
 *   // Embeddable chat widget
 *   const widget = new WidgetSession({ apiUrl, apiKey })
 *   const config = await widget.connect()
 *   widget.on('result', ({ payload }) => render(payload))
 *   await widget.send({ kind: 'image', file: someFile, text: 'mira esto' })
 */

export { runWebhook, WebhookError } from './webhook-session'
export type { WebhookRunInput, WebhookRunResult } from './webhook-session'

export { WebhookStreamSession } from './webhook-stream-session'

export {
  AudioStreamSession,
  AudioStreamError,
  SUPPORTED_AUDIO_CODECS,
} from './audio-stream-session'
export type {
  AudioStreamOptions,
  AudioStreamReady,
  AudioCodec,
} from './audio-stream-session'

export { WidgetSession } from './widget-session'
export type { WidgetSessionOptions, WidgetInitResult, WidgetEventMap } from './widget-session'

export { KnowledgeSession, KnowledgeError } from './knowledge-session'
export type {
  KnowledgeSessionOptions,
  IngestTextInput,
  IngestTextResult,
  SearchInput,
  SearchHit,
  SearchResult,
} from './knowledge-session'

export { uploadFile, UploadError } from './upload'
export type { UploadKind, UploadInput, UploadResult } from './upload'

export { parseToolProgress } from './types'
export type {
  SendableMessage,
  NodeLifecycle,
  StreamEventMap,
  WebhookStreamOptions,
  UploadableFile,
  ReactNativeFileDescriptor,
  ToolProgressEvent,
  ToolProgressResource,
} from './types'

export { Emitter } from './emitter'
export type { Listener } from './emitter'

// ----------------------------------------------- admin client (purely additive)
export { Daguito } from './client'
export type { DaguitoOptions } from './client'

export { DaguitoError } from './admin/http'

export { AccountKeysService } from './admin/account-keys'
export type { CreateAccountKeyInput } from './admin/account-keys'

export { PublicKeysService } from './admin/public-keys'
export type { CreatePublicKeyInput } from './admin/public-keys'

export { BudgetsService } from './admin/budgets'

export type {
  AccountKey,
  AccountKeyCreated,
  PublicKey,
  PublicKeyCreated,
  OrgBudget,
} from './admin/types'
