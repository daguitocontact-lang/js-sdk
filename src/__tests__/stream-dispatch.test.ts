import { describe, expect, it } from 'bun:test'
import { Emitter } from '../emitter'
import { routeStreamFrame } from '../internal/stream-dispatch'
import type { StreamEventMap } from '../types'

function collect() {
  const emitter = new Emitter<StreamEventMap>()
  const events: Array<{ type: keyof StreamEventMap; payload: unknown }> = []
  const keys: Array<keyof StreamEventMap> = [
    'node.token',
    'node.started',
    'node.completed',
    'node.failed',
    'node.emit',
    'flow.completed',
    'flow.failed',
    'error',
  ]
  for (const k of keys) emitter.on(k, (payload) => events.push({ type: k, payload }))
  return { emitter, events }
}

describe('routeStreamFrame', () => {
  it('maps a node.token envelope and returns its cursor', () => {
    const { emitter, events } = collect()
    const cursor = routeStreamFrame(
      { type: 'node.token', node_id: 'n1', data: { token: 'hi' }, __cursor: '5-0' },
      emitter,
      { startedAt: 0 },
    )
    expect(cursor).toBe('5-0')
    expect(events).toEqual([{ type: 'node.token', payload: { nodeId: 'n1', text: 'hi' } }])
  })

  it('forwards node.emit with its kind and raw data', () => {
    const { emitter, events } = collect()
    routeStreamFrame(
      {
        type: 'node.emit',
        node_id: 'c_facts',
        data: { kind: 'collect_data.streaming_update', full_state: { sintomas: ['tos'] } },
      },
      emitter,
      { startedAt: 0 },
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('node.emit')
    expect(events[0]!.payload).toMatchObject({
      nodeId: 'c_facts',
      kind: 'collect_data.streaming_update',
    })
  })

  it('computes flow.completed elapsed from startedAt', () => {
    const { emitter, events } = collect()
    routeStreamFrame(
      { type: 'flow.completed', data: { output: { ok: true } } },
      emitter,
      { startedAt: Date.now() - 50 },
    )
    expect(events).toHaveLength(1)
    const payload = events[0]!.payload as { elapsedMs: number; output: unknown }
    expect(payload.output).toEqual({ ok: true })
    expect(payload.elapsedMs).toBeGreaterThanOrEqual(40)
  })

  it('maps widget-shaped {event:token} frames for robustness', () => {
    const { emitter, events } = collect()
    routeStreamFrame({ event: 'token', content: 'partial' }, emitter, { startedAt: 0 })
    expect(events).toEqual([{ type: 'node.token', payload: { nodeId: '', text: 'partial' } }])
  })

  it('emits error for an error frame', () => {
    const { emitter, events } = collect()
    routeStreamFrame({ type: 'error', message: 'nope' }, emitter, { startedAt: 0 })
    expect(events).toEqual([{ type: 'error', payload: { message: 'nope' } }])
  })
})
