/**
 * Contract tests for `AudioStreamSession`.
 *
 * Uses an in-process fake WebSocket — the session accepts `webSocketImpl`,
 * so we drive every code path without a real server. Built on Node's
 * `node:test`; run with:
 *
 *   node --test tests/audio-stream-session.test.mjs
 *
 * (assumes `pnpm build` has produced `dist/index.js`).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { AudioStreamSession, AudioStreamError, SUPPORTED_AUDIO_CODECS } from '../dist/index.js'

class FakeWebSocket {
  static instances = []
  static OPEN = 1

  constructor(url, _protocols) {
    this.url = url
    this.readyState = FakeWebSocket.OPEN
    this.sent = []
    this.binaryType = 'arraybuffer'
    this.onopen = null
    this.onmessage = null
    this.onerror = null
    this.onclose = null
    FakeWebSocket.instances.push(this)
  }

  send(data) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error('not open')
    }
    this.sent.push(data)
  }

  close() {
    this.readyState = 3
    if (this.onclose) this.onclose({})
  }

  fireMessage(payload) {
    if (this.onmessage) {
      this.onmessage({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) })
    }
  }
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

test('rejects unsupported codec', () => {
  assert.throws(() => {
    new AudioStreamSession({ apiUrl: 'http://x', token: 't', codec: 'mp3' })
  }, AudioStreamError)
})

test('requires sample rate for pcm16', () => {
  assert.throws(() => {
    new AudioStreamSession({ apiUrl: 'http://x', token: 't', codec: 'pcm16' })
  }, AudioStreamError)
})

test('accepts every supported codec', () => {
  for (const codec of SUPPORTED_AUDIO_CODECS) {
    const opts = { apiUrl: 'http://x', token: 't', codec, webSocketImpl: FakeWebSocket }
    if (codec === 'pcm16') opts.sampleRate = 16000
    new AudioStreamSession(opts)
  }
})

test('connect builds URL with token + codec + sr + sdk tracking', async () => {
  FakeWebSocket.instances = []
  const s = new AudioStreamSession({
    apiUrl: 'http://api.example.com',
    token: 'sk_wh_TEST',
    sessionId: 'sess123',
    codec: 'pcm16',
    sampleRate: 16000,
    readyTimeoutMs: 200,
    webSocketImpl: FakeWebSocket,
  })
  const p = s.connect()
  await flush()
  const ws = FakeWebSocket.instances[0]
  assert.ok(ws.url.includes('ws://api.example.com/v1/audio/sess123'))
  assert.ok(ws.url.includes('token=sk_wh_TEST'))
  assert.ok(ws.url.includes('codec=pcm16'))
  assert.ok(ws.url.includes('sr=16000'))
  assert.ok(ws.url.includes('x_daguito_client_lang=js'))
  ws.fireMessage({ type: 'ready', session_key: 'k', codec: 'pcm16' })
  await p
  assert.equal(s.ready.codec, 'pcm16')
  assert.equal(s.ready.sessionKey, 'k')
  s.close()
})

test('connect times out without a ready frame', async () => {
  FakeWebSocket.instances = []
  const s = new AudioStreamSession({
    apiUrl: 'http://x',
    token: 't',
    codec: 'pcm16',
    sampleRate: 16000,
    readyTimeoutMs: 50,
    webSocketImpl: FakeWebSocket,
  })
  await assert.rejects(s.connect(), /timed out/)
})

test('connect surfaces server error frame', async () => {
  FakeWebSocket.instances = []
  const s = new AudioStreamSession({
    apiUrl: 'http://x',
    token: 't',
    codec: 'pcm16',
    sampleRate: 16000,
    readyTimeoutMs: 500,
    webSocketImpl: FakeWebSocket,
  })
  const p = s.connect()
  await flush()
  FakeWebSocket.instances[0].fireMessage({ type: 'error', message: 'bad token' })
  await assert.rejects(p, /bad token/)
})

test('sendAudio forwards binary chunk after ready', async () => {
  FakeWebSocket.instances = []
  const s = new AudioStreamSession({
    apiUrl: 'http://x',
    token: 't',
    codec: 'pcm16',
    sampleRate: 16000,
    readyTimeoutMs: 200,
    webSocketImpl: FakeWebSocket,
  })
  const p = s.connect()
  await flush()
  FakeWebSocket.instances[0].fireMessage({ type: 'ready', session_key: 'k', codec: 'pcm16' })
  await p
  await s.sendAudio(new Uint8Array([1, 2, 3, 4]))
  const sent = FakeWebSocket.instances[0].sent[0]
  assert.ok(sent instanceof ArrayBuffer)
  assert.equal(new Uint8Array(sent).length, 4)
  s.close()
})

test('sendAudio before connect throws', async () => {
  const s = new AudioStreamSession({
    apiUrl: 'http://x',
    token: 't',
    codec: 'pcm16',
    sampleRate: 16000,
    webSocketImpl: FakeWebSocket,
  })
  await assert.rejects(s.sendAudio(new Uint8Array([1])), /not connected/)
})
