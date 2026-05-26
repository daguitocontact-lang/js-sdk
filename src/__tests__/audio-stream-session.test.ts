import { describe, it, expect } from 'bun:test'
import { AudioStreamSession, type AudioStreamOptions } from '../audio-stream-session'

/**
 * Fake `WebSocket` constructor compatible with the global type. The test
 * keeps a registry of every constructed instance so it can drive `onopen`,
 * push frames via `onmessage`, and trigger `onclose` from outside.
 */
class FakeWS {
  static instances: FakeWS[] = []
  readonly url: string
  readyState = 0 // CONNECTING
  binaryType: BinaryType = 'arraybuffer'
  onopen: ((ev: Event) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  sent: Array<ArrayBuffer | string> = []

  constructor(url: string) {
    this.url = url
    FakeWS.instances.push(this)
    // Defer to a microtask so the SDK can set onopen before it fires.
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.(new Event('open'))
    })
  }

  send(data: ArrayBuffer | string): void {
    if (this.readyState !== 1) throw new Error('not open')
    this.sent.push(data)
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.(new CloseEvent('close', { code: 1006, reason: 'simulated drop' }))
  }

  /** Test helper: deliver a JSON frame to the SDK side. */
  push(payload: Record<string, unknown>): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(payload) }))
  }

  /** Test helper: simulate the server cutting the connection mid-session. */
  drop(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.(new CloseEvent('close', { code: 1006, reason: 'simulated drop' }))
  }
}

function baseOpts(extra: Partial<AudioStreamOptions> = {}): AudioStreamOptions {
  return {
    apiUrl: 'https://api.example.com',
    token: 'sk_wh_TEST',
    sessionId: 'resume-me',
    codec: 'pcm16',
    sampleRate: 16_000,
    readyTimeoutMs: 1_000,
    webSocketImpl: FakeWS as unknown as typeof WebSocket,
    ...extra,
  }
}

describe('AudioStreamSession.autoReconnect', () => {
  it('reuses the same sessionId after an unexpected drop', async () => {
    FakeWS.instances = []
    const audio = new AudioStreamSession(baseOpts())
    const connectP = audio.connect()
    // The first FakeWS instance is created synchronously in the WS ctor —
    // wait one microtask for `onopen` to fire, then deliver `ready`.
    await Promise.resolve()
    const ws0 = FakeWS.instances[0]!
    ws0.push({ type: 'ready', session_key: 'sk', codec: 'pcm16' })
    await connectP
    expect(audio.ready).not.toBeNull()

    ws0.drop()
    // Reconnect uses setTimeout(1000) on the first attempt. Wait for it.
    await new Promise((r) => setTimeout(r, 1_200))
    // The reconnect calls connect() again → new WS. Its onopen fires next
    // microtask; we then have to push `ready` so the inner promise resolves.
    expect(FakeWS.instances.length).toBe(2)
    const ws1 = FakeWS.instances[1]!
    ws1.push({ type: 'ready', session_key: 'sk', codec: 'pcm16' })
    // Give the reconnect promise a tick to settle.
    await new Promise((r) => setTimeout(r, 50))
    expect(audio.ready).not.toBeNull()

    // Both URLs must point at the same sessionId path so the server-side
    // Redis stream key stays consistent across the seam.
    expect(ws0.url).toContain('/v1/audio/resume-me')
    expect(ws1.url).toContain('/v1/audio/resume-me')
    audio.close()
  })

  it('sendAudio during the outage drops the chunk silently', async () => {
    FakeWS.instances = []
    const audio = new AudioStreamSession(baseOpts())
    const connectP = audio.connect()
    await Promise.resolve()
    const ws0 = FakeWS.instances[0]!
    ws0.push({ type: 'ready', session_key: 'sk', codec: 'pcm16' })
    await connectP

    ws0.drop()
    // We're now in the reconnect gap. sendAudio must not throw — the
    // mic-pump loop running in the caller would crash otherwise.
    await expect(audio.sendAudio(new Uint8Array([1, 2, 3]))).resolves.toBeUndefined()
    audio.close()
  })

  it('autoReconnect=false surfaces the drop as a thrown sendAudio', async () => {
    FakeWS.instances = []
    const audio = new AudioStreamSession(baseOpts({ autoReconnect: false }))
    const connectP = audio.connect()
    await Promise.resolve()
    const ws0 = FakeWS.instances[0]!
    ws0.push({ type: 'ready', session_key: 'sk', codec: 'pcm16' })
    await connectP

    ws0.drop()
    await expect(audio.sendAudio(new Uint8Array([1, 2, 3]))).rejects.toThrow()
    audio.close()
  })
})
