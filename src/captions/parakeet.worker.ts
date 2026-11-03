/**
 * Captions with Parakeet, in a browser: NVIDIA's NeMo model (the CTC
 * branch of parakeet-tdt_ctc-110m, int8, as sherpa-onnx exports it) run by
 * ONNX Runtime Web's WebAssembly CPU backend, the standard way to run ONNX
 * in a browser. No WebGPU, no WebGL: the CPU is all it asks for.
 *
 * The rest is what sherpa-onnx does around the model in the app: the same
 * features (fbank.ts), greedy CTC over its output, the same tokens. It
 * recognises a whole phrase at a time, so the live captions are the phrase
 * so far read again every so often (rereadMs), and long phrases are cut
 * (maxPhraseSec), since each read costs more the longer it is.
 *
 * One thread: ONNX Runtime's own worker threads would compete with the
 * call's audio for the CPU, and a 110M-parameter model reads a phrase in a
 * fraction of its length on one.
 */
/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm'
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import { NemoFeatures, ctcGreedy, readTokens } from './fbank'
import { run, type Recogniser } from './worker-core'

ort.env.wasm.numThreads = 1
ort.env.wasm.proxy = false
ort.env.wasm.wasmPaths = { wasm: ortWasm }
ort.env.logLevel = 'error'

run(async files => {
  const onnx = files.get('model.int8.onnx')
  const tokens = files.get('tokens.txt')
  if (!onnx || !tokens) throw new Error("the Parakeet model's files aren't all there")
  const session = await ort.InferenceSession.create(new Uint8Array(onnx), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    executionMode: 'sequential'
  })
  files.clear()
  const { pieces, blank } = readTokens(new TextDecoder().decode(tokens))
  const [signalName, lengthName] = session.inputNames
  const outName = session.outputNames[0]
  const features = new NemoFeatures(80)

  // The phrase so far, 16 kHz.
  let phrase = new Float32Array(16_000 * 4)
  let held = 0

  async function read(): Promise<string> {
    if (held < 1600) return ''
    const { data, frames } = features.compute(phrase.subarray(0, held))
    const out = await session.run({
      [signalName]: new ort.Tensor('float32', data, [1, features.numBins, frames]),
      [lengthName]: new ort.Tensor('int64', BigInt64Array.of(BigInt(frames)), [1])
    })
    const lp = out[outName]
    const [, t, v] = lp.dims
    const text = ctcGreedy(lp.data as Float32Array, t, v, blank, pieces)
    lp.dispose()
    return text
  }

  const recogniser: Recogniser = {
    streaming: false,
    get held() {
      return held
    },
    accept(pcm) {
      if (held + pcm.length > phrase.length) {
        const bigger = new Float32Array(Math.max(phrase.length * 2, held + pcm.length))
        bigger.set(phrase.subarray(0, held))
        phrase = bigger
      }
      phrase.set(pcm, held)
      held += pcm.length
      return false
    },
    result: () => '',
    partial: read,
    async finish() {
      const text = await read()
      held = 0
      return text
    },
    configure() {}
  }
  return recogniser
})
