/**
 * PCM16 downsampler worklet. Receives Float32 mic samples at the browser's
 * native rate (usually 48 kHz), downsamples to 16 kHz, converts to Int16
 * little-endian, and posts the ArrayBuffer to the main thread.
 *
 * The main thread forwards each buffer as a binary frame over the audio WS.
 *
 * Why an AudioWorklet and not ScriptProcessorNode:
 *   - ScriptProcessor runs on the main thread (janky, high latency).
 *   - AudioWorklet runs on the audio render thread (low latency, stable).
 */

class PcmDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const params = (options && options.processorOptions) || {}
    this.targetSampleRate = params.targetSampleRate || 16000
    // Accumulate samples across `process` calls until we have enough for
    // one downsampled frame. Each render quantum is 128 frames at sampleRate,
    // so we need N of them before we emit a chunk.
    this.buffer = []
    this.bufferLength = 0
    // How many input samples we want per output chunk. 100 ms @ 16 kHz = 1600
    // output samples. Input (at 48 kHz) = 4800 samples. AssemblyAI v3 requires
    // chunks between 50 ms and 1000 ms — smaller frames are rejected (3007).
    this.chunkSamplesIn = Math.round(sampleRate * 0.1)
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0]) return true

    // Mono downmix — if stereo, average channels.
    const channel0 = input[0]
    const channel1 = input.length > 1 ? input[1] : null
    const mono = new Float32Array(channel0.length)
    for (let i = 0; i < channel0.length; i += 1) {
      mono[i] = channel1 ? (channel0[i] + channel1[i]) * 0.5 : channel0[i]
    }

    this.buffer.push(mono)
    this.bufferLength += mono.length

    while (this.bufferLength >= this.chunkSamplesIn) {
      const chunk = this.consumeChunk(this.chunkSamplesIn)
      const down = downsampleLinear(chunk, sampleRate, this.targetSampleRate)
      const pcm = floatToInt16(down)
      this.port.postMessage(pcm.buffer, [pcm.buffer])
    }

    return true
  }

  consumeChunk(samples) {
    const out = new Float32Array(samples)
    let written = 0
    while (written < samples && this.buffer.length > 0) {
      const head = this.buffer[0]
      const take = Math.min(samples - written, head.length)
      out.set(head.subarray(0, take), written)
      written += take
      if (take === head.length) {
        this.buffer.shift()
      } else {
        this.buffer[0] = head.subarray(take)
      }
    }
    this.bufferLength -= samples
    return out
  }
}

function downsampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input
  const ratio = fromRate / toRate
  const outLength = Math.floor(input.length / ratio)
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i += 1) {
    const srcIndex = i * ratio
    const base = Math.floor(srcIndex)
    const frac = srcIndex - base
    const a = input[base] || 0
    const b = input[base + 1] !== undefined ? input[base + 1] : a
    out[i] = a + (b - a) * frac
  }
  return out
}

function floatToInt16(f32) {
  const i16 = new Int16Array(f32.length)
  for (let i = 0; i < f32.length; i += 1) {
    let s = f32[i]
    if (s > 1) s = 1
    else if (s < -1) s = -1
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return i16
}

registerProcessor('pcm-downsampler', PcmDownsampler)
