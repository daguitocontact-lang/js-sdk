<p align="center">
  <a href="https://daguito.com" target="_blank">
    <img src="https://raw.githubusercontent.com/daguitocontact-lang/js-sdk/main/assets/logo.png" alt="Daguito" width="160" />
  </a>
</p>

<h1 align="center">@daguito/sdk</h1>

<p align="center">
  Official TypeScript SDK for the
  <a href="https://daguito.com">Daguito</a>
  conversational AI platform — text, voice, image, audio, document and video agent flows.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@daguito/sdk"><img src="https://img.shields.io/npm/v/@daguito/sdk.svg?style=flat-square&color=0a0a0a" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@daguito/sdk"><img src="https://img.shields.io/npm/dm/@daguito/sdk.svg?style=flat-square&color=0a0a0a" alt="npm downloads" /></a>
  <a href="https://github.com/daguitocontact-lang/js-sdk/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@daguito/sdk.svg?style=flat-square&color=0a0a0a" alt="license" /></a>
  <a href="https://bundlephobia.com/package/@daguito/sdk"><img src="https://img.shields.io/bundlephobia/minzip/@daguito/sdk?style=flat-square&color=0a0a0a&label=minzip" alt="bundle size" /></a>
</p>

---

Universal: works in the browser and Node 18+. ESM + CJS dual build. Types included.

```bash
npm install @daguito/sdk
# or
pnpm add @daguito/sdk
```

## What's in the box

| Symbol                  | Use it for                                                                       |
| ----------------------- | -------------------------------------------------------------------------------- |
| `runWebhook()`          | One-shot HTTP call to a flow. Wait, get the result.                              |
| `WebhookStreamSession`  | Long-lived WebSocket. Streams tokens, node lifecycle, custom emits.              |
| `WidgetSession`         | Embeddable chat with org `apiKey` — auto-upload for image/audio/document/video.  |
| `VoiceSession`          | Browser-only — mic capture + server STT + streaming TTS playback.                |
| `uploadFile()`          | Presigned upload for attachments outside the widget surface.                     |
| `KnowledgeSession`      | Ingest + search a Knowledge Base with a `sk_dgt_...` org key.                    |

Every event is strongly typed via `StreamEventMap` / `VoiceEventMap`.

## Authentication

| Surface               | Key shape       | Best for                                            |
| --------------------- | --------------- | --------------------------------------------------- |
| Webhook               | `sk_wh_...`     | Server-to-server, custom UI on top of a single flow |
| Widget                | `pk_widget_...` | Embeddable chat on a customer site                  |
| Knowledge Base        | `sk_dgt_...`    | Ingest + search                                     |

Create all three from the Daguito dashboard.

## Quick start

### One-shot webhook

```ts
import { runWebhook } from '@daguito/sdk'

const result = await runWebhook({
  apiUrl: 'https://ingest.daguito.com',
  token: process.env.DAGUITO_WEBHOOK_TOKEN!,
  input: { question: 'What is the capital of France?' },
})
console.log(result.output)
```

Works in Node or browser. No streaming — you get the final flow output.

### Streaming a chat agent

```ts
import { WebhookStreamSession } from '@daguito/sdk'

const session = new WebhookStreamSession({
  apiUrl: 'https://ingest.daguito.com',
  webhookId: 'wh_abc123',
  token: 'sk_wh_...',
})

let buffer = ''
session.on('node.token', ({ text }) => {
  buffer += text
  render(buffer)
})
session.on('flow.completed', ({ elapsedMs }) => console.log(`done in ${elapsedMs}ms`))
session.on('error', ({ message }) => console.error(message))

session.send({ kind: 'text', text: 'Hello!' })
```

### Sending attachments

**Pre-uploaded media key** (server-to-server, or you already uploaded):

```ts
import { uploadFile } from '@daguito/sdk'

const { mediaKey, sizeBytes } = await uploadFile({
  apiUrl: 'https://ingest.daguito.com',
  webhookId: 'wh_abc123',
  token: 'sk_wh_...',
  kind: 'document',         // 'image' | 'audio' | 'document' | 'video'
  file: pdfFile,
})

session.send({
  kind: 'document',
  mediaKey,
  mimeType: 'application/pdf',
  sizeBytes,
  text: 'Summarize this',
})
```

**Public image URL** (no upload, fastest path):

```ts
session.send({ kind: 'image', imageUrl: 'https://...', text: 'Describe this' })

session.send({
  kind: 'image-multi',
  imageUrls: ['https://.../a.jpg', 'https://.../b.jpg'],
  text: 'Compare',
})
```

### Embeddable widget (auto-upload)

The widget surface uploads on your behalf — pass a `File` (or RN file descriptor) and the SDK handles presigning + PUT.

```ts
import { WidgetSession } from '@daguito/sdk'

const widget = new WidgetSession({
  apiUrl: 'https://ingest.daguito.com',
  apiKey: 'pk_widget_...',
  visitorId: localStorage.getItem('visitor_id') ?? undefined,
})

await widget.connect()
widget.on('result', ({ payload }) => render(payload))

await widget.send({ kind: 'text', text: 'Hello' })
await widget.send({ kind: 'image', file: imageFile, text: 'Mira esto' })
await widget.send({ kind: 'audio', file: audioBlob })
await widget.send({ kind: 'document', file: pdfFile, filename: 'invoice.pdf' })
await widget.send({ kind: 'video', file: videoFile, text: 'What happens in this clip?' })

// Form response (resumes a flow paused on a form node)
await widget.send({
  kind: 'form-response',
  formId: 'contact-form',
  payload: { name: 'Ada', email: 'ada@example.com' },
})
```

### Per-session scope (server-enforced KB filter)

When your KB serves many users / workspaces / documents, you want each chat to only see chunks tagged for the right key. Set `scope` on the session — Daguito **forces** every KB search the agent runs to apply it as a metadata filter, server-side. The LLM never sees the values, so it can't widen the search or leak across tenants.

```ts
const session = new WebhookStreamSession({
  apiUrl: 'https://ingest.daguito.com',
  webhookId: 'wh_abc123',
  token: 'sk_wh_...',
  scope: { workspace_id: 'ws_42', document_id: 'doc_abc' },
})
```

Make sure ingest writes the same keys into `metadata` — that's the join. Scope values must be primitives.

### Tool progress events (data-only)

Server-side tools (KB search, media analysis, web search) stream `tool_progress` payloads on `node.emit`. Events are **data-only** — no localized strings — so your client owns the copy and UI.

```ts
import { parseToolProgress } from '@daguito/sdk'

session.on('node.emit', (evt) => {
  const progress = parseToolProgress(evt)
  if (!progress) return
  console.log(progress.tool, progress.stage, progress.resource, progress.result)
})
```

### Knowledge Base

```ts
import { KnowledgeSession } from '@daguito/sdk'

const kb = new KnowledgeSession({
  apiUrl: 'https://ingest.daguito.com',
  apiKey: 'sk_dgt_...',
  defaultSourceId: 'src_abc123',
})

await kb.ingestText({
  text: 'Daguito is a conversational AI platform...',
  metadata: { workspace_id: 'ws_42', kind: 'doc' },
})

const { hits } = await kb.search({ query: 'what is daguito', topK: 5 })
hits.forEach((h) => console.log(h.score, h.content))
```

`apiKey` scopes (`kb:read`, `kb:write`) are configured in the dashboard, optionally restricted to specific KBs.

### Voice agent (browser only)

```ts
import { VoiceSession } from '@daguito/sdk/voice'

const voice = new VoiceSession({
  apiUrl: 'https://ingest.daguito.com',
  webhookId: 'wh_voice_...',
  token: 'sk_wh_...',
})

voice.on('voice.ready', () => console.log('mic up'))
voice.on('mic.level', ({ rms }) => paintMeter(rms))
voice.on('transcript.partial', ({ text }) => showLive(text))
voice.on('transcript.final', ({ text }) => appendUser(text))
voice.on('node.token', ({ text }) => appendBot(text))
voice.on('tts.url', ({ url }) => { audioEl.src = url; audioEl.play() })

await voice.start()
// ...
await voice.stop()
```

#### Worklet setup

`VoiceSession` uses an `AudioWorklet`. Copy the file into your public dir:

```bash
cp node_modules/@daguito/sdk/assets/pcm-worklet.js public/pcm-worklet.js
```

Or set `workletUrl: '/static/audio/daguito-pcm-worklet.js'` in the constructor.

## React Native / Expo

The root SDK runs in RN with one caveat: there's no `File`. Pass the descriptor your picker returns instead.

```ts
import * as ImagePicker from 'expo-image-picker'
import { WidgetSession } from '@daguito/sdk'

const widget = new WidgetSession({ apiUrl, apiKey })
await widget.connect()

const r = await ImagePicker.launchImageLibraryAsync({ quality: 0.8 })
if (r.canceled) return
const asset = r.assets[0]

await widget.send({
  kind: 'image',
  file: { uri: asset.uri, type: asset.mimeType ?? 'image/jpeg', name: asset.fileName ?? 'photo.jpg', size: asset.fileSize },
  text: 'analyse this',
})
```

`@daguito/sdk/voice` is **not** RN-compatible — capture audio with `expo-av` and send the file via the audio kind instead.

For RN < 0.74 add `react-native-url-polyfill/auto` and `react-native-get-random-values` at app startup. Expo 50+ already includes these.

## Event reference

### `WebhookStreamSession` / `VoiceSession`

| Event            | Payload                            | When                         |
| ---------------- | ---------------------------------- | ---------------------------- |
| `ready`          | `{ webhookId }`                    | Socket authenticated         |
| `closed`         | `{ code?, reason? }`               | Transport closed             |
| `node.started`   | `{ nodeId }`                       | Engine entered a node        |
| `node.token`     | `{ nodeId, text }`                 | LLM streaming token          |
| `node.completed` | `{ nodeId, durationMs?, output? }` | Node finished                |
| `node.failed`    | `{ nodeId, error? }`               | Node errored                 |
| `node.emit`      | `{ nodeId, kind, data }`           | Tool progress, intent emits, custom telemetry |
| `flow.completed` | `{ elapsedMs, output? }`           | Engine finished              |
| `flow.failed`    | `{ error }`                        | Engine errored               |
| `error`          | `{ message }`                      | Protocol-level error         |

### `VoiceSession` extras

| Event                | Payload                          |
| -------------------- | -------------------------------- |
| `voice.ready`        | `{}`                             |
| `voice.stopped`      | `{ elapsedMs }`                  |
| `mic.level`          | `{ rms }`                        |
| `transcript.partial` | `{ text }`                       |
| `transcript.final`   | `{ text }`                       |
| `tts.url`            | `{ url }` (attach to `<audio>`)  |
| `tts.chunk`          | `{ bytes, index }`               |
| `tts.done`           | `{ totalBytes }`                 |

### `WidgetSession`

| Event       | Payload              |
| ----------- | -------------------- |
| `connected` | `{ sessionId }`      |
| `result`    | `{ payload }`        |
| `error`     | `{ message }`        |
| `closed`    | `{ code?, reason? }` |

## Modality cheat sheet

| Modality                        | Webhook stream                       | Widget (auto-upload)            |
| ------------------------------- | ------------------------------------ | ------------------------------- |
| Text                            | ✅                                   | ✅                              |
| Image (URL)                     | ✅                                   | use `file` or `mediaKey`        |
| Image (file)                    | upload first → `mediaKey`            | ✅                              |
| Image-multi                     | ✅ (URLs)                            | ❌                              |
| Audio                           | upload first → `mediaKey`            | ✅                              |
| Document                        | upload first → `mediaKey`            | ✅                              |
| Video                           | upload first → `mediaKey`            | ✅                              |
| Voice / mic streaming           | `VoiceSession` (browser)             | —                               |
| Form response                   | `base_input`                         | ✅                              |
| Knowledge Base                  | `KnowledgeSession`                   | `KnowledgeSession`              |

## Runtime support

| Module                | Browser | Node 18+                                                | React Native / Expo |
| --------------------- | ------- | ------------------------------------------------------- | ------------------- |
| `@daguito/sdk` (root) | ✅      | ✅                                                      | ✅                  |
| `@daguito/sdk/voice`  | ✅      | ❌ (`getUserMedia`, `AudioWorklet`, `MediaSource`)      | ❌                  |

Cloudflare Workers / Vercel Edge are supported out of the box (the SDK is ESM and tree-shakeable).

## TypeScript

```ts
import type {
  SendableMessage,
  StreamEventMap,
  WebhookStreamOptions,
  ToolProgressEvent,
} from '@daguito/sdk'
import type { VoiceEventMap } from '@daguito/sdk/voice'
```

## Resources

- 🌐 [daguito.com](https://daguito.com) — landing & dashboard
- 📚 [docs.daguito.com](https://docs.daguito.com) — full API + flow reference
- 💬 [Examples gallery](https://examples.daguito.com)
- 🐛 [Issues](https://github.com/daguitocontact-lang/js-sdk/issues)
- 📦 [Source](https://github.com/daguitocontact-lang/js-sdk)

## License

MIT © [Daguito, LLC](https://daguito.com)
