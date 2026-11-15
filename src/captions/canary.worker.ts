/** Canary 180M Flash INT8 on the CPU, in this worker alone (no GPU or server transcription). */
/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm'
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import { Canary, type CanaryModel } from './canary'
import { readTokens } from './fbank'
import { onnxMetadata } from './onnx-meta'
import { run } from './worker-core'

ort.env.wasm.numThreads = 1
ort.env.wasm.proxy = false
ort.env.wasm.wasmPaths = { wasm: ortWasm }
ort.env.logLevel = 'error'

run(async (files, _model, cfg) => {
  const enc = files.get('encoder.int8.onnx')
  const dec = files.get('decoder.int8.onnx')
  const tokens = files.get('tokens.txt')
  if (!enc || !dec || !tokens) throw new Error("the Canary model's files aren't all there")
  const meta = onnxMetadata(enc)
  const { pieces } = readTokens(new TextDecoder().decode(tokens))
  if (meta.get('model_type') !== 'EncDecMultiTaskModel' || meta.get('feat_dim') !== '128' || meta.get('normalize_type') !== 'per_feature' || Number(meta.get('vocab_size')) !== pieces.length) {
    throw new Error('unsupported Canary export')
  }
  const options: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all', executionMode: 'sequential' }
  const encoder = await ort.InferenceSession.create(new Uint8Array(enc), options)
  let decoder: ort.InferenceSession
  try { decoder = await ort.InferenceSession.create(new Uint8Array(dec), options) }
  catch (e) { await encoder.release(); throw e }
  files.clear()

  // The pinned export has six [1, tokens, 1024] memory tensors, initially empty.
  let memories: ort.Tensor[] = []
  let states: ort.Tensor | null = null
  let mask: ort.Tensor | null = null
  const model: CanaryModel = {
    async encode(features, frames) {
      model.reset()
      const x = new ort.Tensor('float32', features, [1, frames, 128])
      const len = new ort.Tensor('int64', BigInt64Array.of(BigInt(frames)), [1])
      try {
        const out = await encoder.run({ [encoder.inputNames[0]]: x, [encoder.inputNames[1]]: len })
        states = out[encoder.outputNames[0]]
        mask = out[encoder.outputNames[2]]
        out[encoder.outputNames[1]].dispose()
        memories = Array.from({ length: 6 }, () => new ort.Tensor('float32', new Float32Array(0), [1, 0, 1024]))
        return states.dims[1]
      } finally { x.dispose(); len.dispose() }
    },
    async step(token, position) {
      const input = new ort.Tensor('int32', Int32Array.of(token, position), [1, 2])
      try {
        const feeds: Record<string, ort.Tensor> = { [decoder.inputNames[0]]: input, [decoder.inputNames[7]]: states!, [decoder.inputNames[8]]: mask! }
        memories.forEach((m, i) => feeds[decoder.inputNames[i + 1]] = m)
        const out = await decoder.run(feeds)
        memories.forEach(m => m.dispose())
        memories = decoder.outputNames.slice(1).map(name => out[name])
        const logits = out[decoder.outputNames[0]]
        try { return (logits.data as Float32Array).slice() }
        finally { logits.dispose() }
      } finally { input.dispose() }
    },
    reset() {
      memories.forEach(m => m.dispose())
      memories = []
      states?.dispose()
      mask?.dispose()
      states = mask = null
    }
  }
  return new Canary(model, pieces, cfg.language, cfg.suppressUnstableOutput)
})
