/**
 * Public types the SDK exposes to integrators. All identifiers and event
 * names come from the platform's wire protocol — see the `sdks/spec/`
 * folder (when published) for the canonical contract.
 */

/**
 * React Native / Expo image-picker descriptor. RN doesn't have `File`, and
 * its `Blob` lacks the byte-stream the presigned PUT needs — instead the
 * platform's `fetch` understands a `{ uri, type, name }` object as a body.
 * The optional `size` lets integrators pass a known byte count (image
 * pickers expose it as `fileSize`); when absent, the upload signer falls
 * back to a permissive size check.
 */
export interface ReactNativeFileDescriptor {
  uri: string
  type: string
  name: string
  size?: number
}

/**
 * Anything the SDK accepts as a file payload, across runtimes:
 *   - browser / Node 18+: `File` or `Blob`
 *   - React Native / Expo: `{ uri, type, name, size? }`
 */
export type UploadableFile = File | Blob | ReactNativeFileDescriptor

/**
 * Every modality the platform accepts. Maps 1:1 to the canonical
 * `MessageKind` enum on the server (`@daguito/core/messages/kinds.ts`).
 *
 * For media kinds the integrator can pass either:
 *   - `file` (an `UploadableFile`): SDK uploads it via presigned PUT and
 *     rewrites the inbound to reference the uploaded media key.
 *   - `mediaKey` + `mimeType` + `sizeBytes`: pre-uploaded media (caller
 *     handled the upload elsewhere).
 *   - `imageUrl` / `imageUrls`: hosted images on a public URL — gets
 *     forwarded as `base_input` so the flow can fetch them directly.
 */
export type SendableMessage =
  | { kind: 'text'; text: string }
  | { kind: 'image'; file: UploadableFile; text?: string; filename?: string }
  | {
      kind: 'image'
      mediaKey: string
      mimeType: string
      sizeBytes: number
      text?: string
    }
  | { kind: 'image'; imageUrl: string; text?: string }
  | { kind: 'image-multi'; imageUrls: string[]; text?: string }
  | { kind: 'audio'; file: UploadableFile; text?: string; filename?: string }
  | {
      kind: 'audio'
      mediaKey: string
      mimeType: string
      sizeBytes: number
      text?: string
    }
  | { kind: 'document'; file: UploadableFile; text?: string; filename?: string }
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
  /**
   * Custom node telemetry — anything emitted via `ctx.emit()` server-side.
   *
   * The platform reserves `data.kind === 'tool_progress'` for long-running
   * tool telemetry (web search, media description, KB indexing, …). Use
   * `parseToolProgress(data)` to narrow it into a typed `ToolProgressEvent`.
   */
  'node.emit': { nodeId: string; kind: string; data: Record<string, unknown> }
  'flow.completed': { elapsedMs: number; output?: unknown }
  'flow.failed': { error: string }
  /** Auth/protocol error coming back from the server. */
  error: { message: string }
}

/**
 * Resource a tool is currently working on (the document being indexed,
 * the URL being fetched, the image being described, …). Every field is
 * optional — the server only fills what it has at each stage.
 */
export interface ToolProgressResource {
  kind?: string
  name?: string
  mediaKey?: string
  url?: string
}

/**
 * Data-only progress event.
 *
 * Rides on `node.emit` with `data.kind === 'tool_progress'`. Use
 * `parseToolProgress` to narrow the untyped `data` payload into this shape
 * inside your `node.emit` handler.
 */
export interface ToolProgressEvent {
  tool: string
  stage: string
  progress?: number
  resource?: ToolProgressResource
  traceId?: string
  attempt?: number
}

/**
 * Narrow a `node.emit` payload's `data` into a typed `ToolProgressEvent`.
 * Returns `null` for any payload whose `kind` is not `'tool_progress'`,
 * so callers can use it as a discriminator without an extra check.
 */
export function parseToolProgress(data: unknown): ToolProgressEvent | null {
  if (!isRecord(data) || data.kind !== 'tool_progress') return null

  const tool = typeof data.tool === 'string' ? data.tool : ''
  const stage = typeof data.stage === 'string' ? data.stage : ''
  const progress = typeof data.progress === 'number' ? data.progress : undefined
  const attempt =
    typeof data.attempt === 'number' && Number.isInteger(data.attempt)
      ? data.attempt
      : undefined
  const traceId = typeof data.trace_id === 'string' ? data.trace_id : undefined

  let resource: ToolProgressResource | undefined
  const rawResource = data.resource
  if (isRecord(rawResource)) {
    resource = {
      kind: typeof rawResource.kind === 'string' ? rawResource.kind : undefined,
      name: typeof rawResource.name === 'string' ? rawResource.name : undefined,
      mediaKey:
        typeof rawResource.media_key === 'string' ? rawResource.media_key : undefined,
      url: typeof rawResource.url === 'string' ? rawResource.url : undefined,
    }
  }

  return { tool, stage, progress, resource, traceId, attempt }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
