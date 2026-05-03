# @daguito/sdk

Official TypeScript SDK for the [Daguito](https://daguito.com) conversational AI platform.

Build text, voice, image, and multimodal agent integrations on top of Daguito flows. Works in the browser and Node.js 18+.

```bash
npm install @daguito/sdk
# or
pnpm add @daguito/sdk
```

## What you get

- **`runWebhook()`** — one-shot HTTP call to a webhook flow. Wait, get the result.
- **`WebhookStreamSession`** — long-lived WebSocket for streaming flows. Token streaming, node lifecycle, custom emits.
- **`WidgetSession`** — embeddable chat with org `api_key` auth, multimodal send (text + image + audio + document with auto-upload), form responses.
- **`VoiceSession`** (`@daguito/sdk/voice`) — full voice agent: mic capture, audio streaming, server-side STT, streaming TTS playback. Browser only.

## Authentication

The SDK supports two auth surfaces:

| Surface | Auth | Best for |
|---|---|---|
| Webhook (`sk_wh_...`) | Token issued per-flow | Server-to-server, custom UI on top of a single flow |
| Widget (`api_key`) | Org-scoped public key | Embeddable chat on a customer site |

Create webhooks and api_keys from your Daguito dashboard.

## Quick start

### One-shot webhook

```ts
import { runWebhook } from '@daguito/sdk'

const result = await runWebhook({
  apiUrl: 'https://api.daguito.com',
  token: process.env.DAGUITO_WEBHOOK_TOKEN!,
  input: { question: 'What is the price of BTC?' },
})

console.log(result.output)
```

Works in Node.js or browser. No streaming — you get the final flow output.

### Streaming webhook (text agent)

```ts
import { WebhookStreamSession } from '@daguito/sdk'

const session = new WebhookStreamSession({
  apiUrl: 'https://api.daguito.com',
  webhookId: 'wh_abc123',
  token: 'sk_wh_...',
})

let buffer = ''
session.on('node.token', ({ text }) => {
  buffer += text
  render(buffer)
})
session.on('node.completed', ({ nodeId, durationMs }) => {
  console.log(`✓ ${nodeId} (${durationMs}ms)`)
})
session.on('flow.completed', ({ elapsedMs }) => {
  console.log(`Done in ${elapsedMs}ms`)
})
session.on('error', ({ message }) => console.error(message))

session.send({ kind: 'text', text: 'Hola, ¿qué tal?' })
```

### Streaming with images

```ts
// Hosted on a public URL (works on streaming-webhook surface)
session.send({ kind: 'image', imageUrl: 'https://...', text: 'Describe this' })

// Multiple images
session.send({ kind: 'image-multi', imageUrls: [url1, url2], text: 'Compare' })

// Pre-uploaded (you handled the upload elsewhere)
session.send({
  kind: 'image',
  mediaKey: 'media/.../abc.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 234_567,
})
```

> Need to upload a `File` directly from a browser? Use `WidgetSession` (the only surface with a presigned-upload endpoint today).

### Embeddable widget (multimodal with auto-upload)

```ts
import { WidgetSession } from '@daguito/sdk'

const widget = new WidgetSession({
  apiUrl: 'https://api.daguito.com',
  apiKey: 'pk_widget_...',
  visitorId: localStorage.getItem('visitor_id') ?? undefined,
})

const config = await widget.connect()
console.log(config.config.welcomeMessage)

widget.on('result', ({ payload }) => {
  appendBotMessage(payload)
})

// Text
await widget.send({ kind: 'text', text: 'Hola' })

// Image — SDK auto-uploads
const file = inputEl.files![0]
await widget.send({ kind: 'image', file, text: 'Mira esto' })

// Audio — same pattern
await widget.send({ kind: 'audio', file: audioBlob })

// Document
await widget.send({ kind: 'document', file: pdfFile, filename: 'invoice.pdf' })

// Form response (resumes a flow paused on a form node)
await widget.send({
  kind: 'form-response',
  formId: 'contact-form',
  payload: { name: 'Ada', email: 'ada@example.com' },
})
```

### Knowledge Search

```ts
import { KnowledgeSession } from '@daguito/sdk'

const kb = new KnowledgeSession({
  apiUrl: 'https://api.daguito.com',
  apiKey: 'sk_dgt_...',
  defaultSourceId: 'src_abc123',
})

// Ingest text — chunks + embeds + indexes server-side
await kb.ingestText({
  text: 'MacBook Pro M4 Max with 64GB RAM...',
  metadata: { category: 'laptop', price_usd: 3499 },
})

// Search — vector + keyword hybrid
const { hits } = await kb.search({ query: 'laptops para video', topK: 3 })
hits.forEach(h => console.log(h.score, h.content, h.metadata))
```

The `apiKey` controls scopes. Mint one from the dashboard with `kb:read` and/or `kb:write` actions, optionally limited to specific KBs.

### Voice agent (browser only)

```ts
import { VoiceSession } from '@daguito/sdk/voice'

const voice = new VoiceSession({
  apiUrl: 'https://api.daguito.com',
  webhookId: 'wh_voice_...',
  token: 'sk_wh_...',
})

voice.on('voice.ready', () => console.log('mic + sockets up'))
voice.on('mic.level', ({ rms }) => paintMeter(rms))
voice.on('transcript.partial', ({ text }) => showLive(text))
voice.on('transcript.final', ({ text }) => appendUser(text))
voice.on('node.token', ({ text }) => appendBot(text))
voice.on('tts.url', ({ url }) => {
  audioElement.src = url
  audioElement.play()
})
voice.on('voice.stopped', ({ elapsedMs }) => console.log(`stopped after ${elapsedMs}ms`))

await voice.start()
// ...
await voice.stop()
```

#### Voice setup: serving the worklet

`VoiceSession` uses an `AudioWorklet` for low-latency PCM downsampling. Copy the worklet file into your public/ directory:

```bash
# Vite / Next.js / similar
cp node_modules/@daguito/sdk/assets/pcm-worklet.js public/pcm-worklet.js
```

Or override the location:

```ts
new VoiceSession({ ..., workletUrl: '/static/audio/daguito-pcm-worklet.js' })
```

## Browser vs Node.js

| Module | Browser | Node 18+ |
|---|---|---|
| `@daguito/sdk` (root) | ✅ | ✅ |
| `@daguito/sdk/voice` | ✅ | ❌ (uses `getUserMedia`, `AudioWorklet`, `MediaSource`) |

The root entry uses only `fetch` and `WebSocket`, both standard in Node 18+.

## Event reference

### `WebhookStreamSession` and `VoiceSession` events

| Event | Payload | When |
|---|---|---|
| `ready` | `{ webhookId }` | Socket authenticated |
| `closed` | `{ code?, reason? }` | Transport closed |
| `node.started` | `{ nodeId }` | Engine entered a node |
| `node.token` | `{ nodeId, text }` | LLM streaming token |
| `node.completed` | `{ nodeId, durationMs?, output? }` | Node finished |
| `node.failed` | `{ nodeId, error? }` | Node errored |
| `node.emit` | `{ nodeId, kind, data }` | Custom telemetry from a node |
| `flow.completed` | `{ elapsedMs, output? }` | Engine finished |
| `flow.failed` | `{ error }` | Engine errored |
| `error` | `{ message }` | Protocol-level error |

### `VoiceSession` adds

| Event | Payload |
|---|---|
| `voice.ready` | `{}` |
| `voice.stopped` | `{ elapsedMs }` |
| `mic.level` | `{ rms }` (0..1) |
| `transcript.partial` | `{ text }` |
| `transcript.final` | `{ text }` |
| `transcript.error` | `{ error }` |
| `tts.url` | `{ url }` (attach to `<audio>`) |
| `tts.chunk` | `{ bytes, index }` |
| `tts.done` | `{ totalBytes }` |
| `tts.error` | `{ error }` |

### `WidgetSession` events

| Event | Payload |
|---|---|
| `connected` | `{ sessionId }` |
| `result` | `{ payload }` |
| `error` | `{ message }` |
| `closed` | `{ code?, reason? }` |

## Multimodal cheat sheet

| Modality | Webhook stream | Widget |
|---|---|---|
| `text` | ✅ | ✅ |
| `image` (URL) | ✅ | ❌ — pass `file` or `mediaKey` |
| `image` (File auto-upload) | ❌ | ✅ |
| `image` (pre-uploaded mediaKey) | ✅ | ✅ |
| `image-multi` | ✅ | ❌ |
| `audio` (File auto-upload) | ❌ | ✅ |
| `audio` (mediaKey) | ✅ | ✅ |
| `document` | ❌ | ✅ |
| Voice / mic streaming | use `VoiceSession` | — |
| `form-response` | base_input | ✅ |
| Knowledge Base | ✅ via `KnowledgeSession` | ✅ via `KnowledgeSession` |

## Testing from Node (no browser)

The root entry runs in Node 18+ unchanged — `fetch` and `WebSocket` are standard. Useful for backend integrations, CI smoke tests, or just probing a flow from the terminal.

```bash
# One-shot HTTP webhook
DAGUITO_API_URL=https://api.daguito.com \
DAGUITO_TOKEN=sk_wh_xxx \
node examples/run-webhook.mjs "What's the price of BTC?"

# Streaming WS — prints tokens as they arrive
DAGUITO_API_URL=https://api.daguito.com \
DAGUITO_WEBHOOK_ID=wh_abc123 \
DAGUITO_TOKEN=sk_wh_xxx \
node examples/stream-webhook.mjs "Cuéntame un cuento corto"

# Self-contained smoke test — spins up a mock server, no real backend
node examples/mock-server-smoke.mjs
```

The smoke test is the fastest way to verify your SDK install works: it boots an in-process HTTP+WS mock, runs a one-shot and a streaming session against it, and exits non-zero on any protocol mismatch.

`@daguito/sdk/voice` is the only browser-only entry — it depends on `getUserMedia`, `AudioWorklet`, and `MediaSource`. Importing it from Node throws when the session starts.

## TypeScript

The SDK is written in TypeScript and ships its own types. No `@types/` package needed.

```ts
import type { SendableMessage, StreamEventMap } from '@daguito/sdk'
import type { VoiceEventMap } from '@daguito/sdk/voice'
```

## License

MIT © Daguito, LLC
