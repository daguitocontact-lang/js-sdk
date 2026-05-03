/**
 * Public types the SDK exposes to integrators. All identifiers and event
 * names come from the platform's wire protocol — see the `sdks/spec/`
 * folder (when published) for the canonical contract.
 */

/**
 * Every modality the platform accepts. Maps 1:1 to the canonical
 * `MessageKind` enum on the server (`@daguito/core/messages/kinds.ts`).
 *
 * For media kinds the integrator can pass either:
 *   - `file` (a File / Blob): SDK uploads it via presigned PUT and rewrites
 *     the inbound to reference the uploaded media key.
 *   - `mediaKey` + `mimeType` + `sizeBytes`: pre-uploaded media (caller
 *     handled the upload elsewhere).
 *   - `imageUrl` / `imageUrls`: hosted images on a public URL — gets
 *     forwarded as `base_input` so the flow can fetch them directly.
 */
export type SendableMessage =
  | { kind: 'text'; text: string }
  | { kind: 'image'; file: File | Blob; text?: string; filename?: string }
  | {
      kind: 'image'
      mediaKey: string
      mimeType: string
      sizeBytes: number
      text?: string
    }
  | { kind: 'image'; imageUrl: string; text?: string }
  | { kind: 'image-multi'; imageUrls: string[]; text?: string }
  | { kind: 'audio'; file: File | Blob; text?: string; filename?: string }
  | {
      kind: 'audio'
      mediaKey: string
      mimeType: string
      sizeBytes: number
      text?: string
    }
  | { kind: 'document'; file: File | Blob; text?: string; filename?: string }
  | {
      kind: 'document'
      mediaKey: string
      mimeType: string
      sizeBytes: number
      text?: string
    }
  | { kind: 'form-response'; formId: string; payload: Record<string, unknown> }

export type NodeLifecycle = 'started' | 'completed' | 'failed'

/**
 * Semantic events surfaced by streaming sessions. Flat namespace, no
 * inheritance — easier to consume from a UI reducer / Redux saga than
 * the wire-level FlowEvent envelope.
 */
export type StreamEventMap = {
  /** Connection-level: socket opened and authenticated. */
  ready: { webhookId: string }
  /** Connection-level: socket closed. */
  closed: { code?: number; reason?: string }
  /** Token streaming from a generation node — append `text` to the buffer. */
  'node.token': { nodeId: string; text: string }
  'node.started': { nodeId: string }
  'node.completed': { nodeId: string; durationMs?: number; output?: unknown }
  'node.failed': { nodeId: string; error?: string }
  /** Custom node telemetry — anything emitted via `ctx.emit()` server-side. */
  'node.emit': { nodeId: string; kind: string; data: Record<string, unknown> }
  'flow.completed': { elapsedMs: number; output?: unknown }
  'flow.failed': { error: string }
  /** Auth/protocol error coming back from the server. */
  error: { message: string }
}

/** Options shared by every session that talks to the streaming WS. */
export interface WebhookStreamOptions {
  apiUrl: string
  webhookId: string
  /** Webhook token, e.g. `sk_wh_...`. */
  token: string
  /** Defaults to a generated UUID with a `web-` prefix. */
  sessionKey?: string
  /** Override the base_input passed to the flow. */
  baseInput?: Record<string, unknown>
  /** Auto-reconnect on transport drop. Default: true. */
  autoReconnect?: boolean
}
