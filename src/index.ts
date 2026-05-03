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

export { uploadFile } from './upload'
export type { UploadInput, UploadResult } from './upload'

export type {
  SendableMessage,
  NodeLifecycle,
  StreamEventMap,
  WebhookStreamOptions,
} from './types'

export { Emitter } from './emitter'
export type { Listener } from './emitter'
