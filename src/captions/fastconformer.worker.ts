/**
 * Captions with NVIDIA's streaming FastConformer, in a browser: its CTC
 * branch (int8, as sherpa-onnx exports it), run by ONNX Runtime Web's
 * WebAssembly CPU backend, one thread, like Parakeet. Unlike Parakeet it
 * streams: the model reads the audio a chunk at a time as it arrives and
 * keeps what it needs of the past in caches it hands back each time
 * (streaming-ctc.ts), so nothing is read twice and live words cost nothing
 * extra. Lowercase, no punctuation.
 */
/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm'
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import { readTokens } from './fbank'
import { onnxMetadata, streamingCtcMeta } from './onnx-meta'
import { StreamingCtc, type StreamingModel } from './streaming-ctc'
import { run, type Recogniser } from './worker-core'

ort.env.wasm.numThreads = 1
ort.env.wasm.proxy = false
ort.env.wasm.wasmPaths = { wasm: ortWasm }
ort.env.logLevel = 'error'

run(async (files, _model, cfg0) => {
  const onnx = files.get('model.int8.onnx')
  const tokens = files.get('tokens.txt')
  if (!onnx || !tokens) throw new Error("the FastConformer model's files aren't all there")
  const meta = streamingCtcMeta(onnxMetadata(onnx))
  const { window, shift } = meta
  const session = await ort.InferenceSession.create(new Uint8Array(onnx), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    executionMode: 'sequential'
  })
  files.clear()
  const { pieces, blank } = readTokens(new TextDecoder().decode(tokens))
  const [signal, length, channelIn, timeIn, lenIn] = session.inputNames
  const [logprobsOut, , channelOut, timeOut, lenOut] = session.outputNames

  // The caches start empty, and are the model's own output after that.
  const size = (s: number[]) => s.reduce((a, b) => a * b, 1)
  const empty = () => ({
    channel: new ort.Tensor('float32', new Float32Array(size(meta.channel)), meta.channel),
    time: new ort.Tensor('float32', new Float32Array(size(meta.time)), meta.time),
    len: new ort.Tensor('int64', new BigInt64Array(1), [1])
  })
  const start = empty()
  let caches = start
  const len = new ort.Tensor('int64', BigInt64Array.of(BigInt(window)), [1])
  const outputs = [logprobsOut, channelOut, timeOut, lenOut]

  const model: StreamingModel = {
    window,
    shift,
    async run(x) {
      const out = await session.run(
        {
          [signal]: new ort.Tensor('float32', x, [1, 80, window]),
          [length]: len,
          [channelIn]: caches.channel,
          [timeIn]: caches.time,
          [lenIn]: caches.len
        },
        outputs
      )
      drop()
      caches = { channel: out[channelOut] as typeof start.channel, time: out[timeOut] as typeof start.time, len: out[lenOut] as typeof start.len }
      const lp = out[logprobsOut]
      return { logprobs: lp.data as Float32Array, frames: lp.dims[1] }
    },
    reset() {
      drop()
      caches = start
    }
  }
  function drop() {
    if (caches === start) return
    caches.channel.dispose()
    caches.time.dispose()
    caches.len.dispose()
  }

  const ctc = new StreamingCtc(model, pieces, blank)
  ctc.maxPhraseSec = cfg0.maxPhraseSec
  const recogniser: Recogniser = {
    streaming: true,
    get held() {
      return ctc.held
    },
    accept: pcm => ctc.accept(pcm),
    result: () => ctc.result(),
    partial: () => ctc.text,
    finish: () => ctc.finish(),
    configure(cfg) {
      ctc.maxPhraseSec = cfg.maxPhraseSec
    }
  }
  return recogniser
})
