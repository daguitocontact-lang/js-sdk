import type { Emitter } from '../emitter'
import type { StreamEventMap } from '../types'

/**
 * Shared frame → semantic-event router for every consuming surface
 * (WebhookStreamSession, OutputStream, FlowChannel.output). Connection-protocol
 * frames (`ready`, `session.started`, `pong`, …) stay in each session; this
 * routes only the FlowEvent envelopes into the typed `StreamEventMap`.
 *
 * `state.startedAt` is owned by the caller (set when its session starts) and
 * read here to compute `flow.completed` elapsed time.
 *
 * Returns the entry's durable cursor (`__cursor`) when present so consumers can
 * persist their resume point.
 */
export function routeStreamFrame(
  frame: Record<string, unknown>,
  emitter: Emitter<StreamEventMap>,
  state: { startedAt: number },
): string | undefined {
  const type = typeof frame.type === 'string' ? frame.type : ''
  const cursor = typeof frame.__cursor === 'string' ? frame.__cursor : undefined

  // Widget-shaped frames (`{event:'token'|'done'|'error'}`) — webhook consumers
  // normally receive node.* envelopes instead, but stay robust if pointed at a
  // raw token stream.
  if (!type && typeof frame.event === 'string') {
    if (frame.event === 'token') {
      const text = pickToken(frame)
      if (text) emitter.emit('node.token', { nodeId: '', text })
    } else if (frame.event === 'done') {
      emitter.emit('flow.completed', {
        elapsedMs: state.startedAt ? Date.now() - state.startedAt : 0,
        output: frame.output,
      })
    } else if (frame.event === 'error') {
      emitter.emit('error', { message: String(frame.error ?? 'stream error') })
    }
    return cursor
  }

  if (type === 'error') {
    emitter.emit('error', { message: String(frame.message ?? 'unknown error') })
    return cursor
  }

  const data = (frame.data ?? {}) as Record<string, unknown>
  const nodeId = typeof frame.node_id === 'string' ? frame.node_id : ''

  if (type === 'node.token') {
    const text = pickToken(data)
    if (text) emitter.emit('node.token', { nodeId, text })
    return cursor
  }

  if (type === 'node.started' || type === 'merge.progress') {
    emitter.emit('node.started', { nodeId })
    return cursor
  }

  if (type === 'node.completed') {
    const durationMs =
      typeof data.duration_ms === 'number'
        ? data.duration_ms
        : typeof data.elapsed_ms === 'number'
          ? data.elapsed_ms
          : undefined
    emitter.emit('node.completed', { nodeId, durationMs, output: data.output })
    return cursor
  }

  if (type === 'node.failed') {
    const error = typeof data.error === 'string' ? data.error : undefined
    emitter.emit('node.failed', { nodeId, error })
    return cursor
  }

  if (type === 'node.emit') {
    const kind = typeof data.kind === 'string' ? data.kind : ''
    emitter.emit('node.emit', { nodeId, kind, data })
    return cursor
  }

  if (type === 'flow.completed') {
    const elapsedMs = state.startedAt ? Date.now() - state.startedAt : 0
    emitter.emit('flow.completed', { elapsedMs, output: data.output })
    return cursor
  }

  if (type === 'flow.failed') {
    const error = typeof data.error === 'string' ? data.error : 'flow failed'
    emitter.emit('flow.failed', { error })
    return cursor
  }

  return cursor
}

function pickToken(data: Record<string, unknown>): string {
  for (const key of ['token', 'text', 'delta', 'content'] as const) {
    const value = data[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}
