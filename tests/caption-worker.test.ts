import { afterEach, expect, it, vi } from 'vitest'
import { CAPTION_DEFAULTS } from '../src/captions/config'
import { run, type FromCaptionWorker, type Recogniser, type ToCaptionWorker } from '../src/captions/worker-core'

vi.mock('../src/captions/models', async importOriginal => ({
  ...await importOriginal<typeof import('../src/captions/models')>(),
  modelOf: () => ({ id: 'canary-180m-flash', files: [['test', 'sha', 1]] }),
  cachedFiles: async () => new Set(['test']),
  readCached: async () => new ArrayBuffer(1)
}))

afterEach(() => vi.unstubAllGlobals())

it('reports a failed decode and stops feeding the broken recogniser', async () => {
  const messages: FromCaptionWorker[] = []
  const worker = { onmessage: (_e: MessageEvent<ToCaptionWorker>) => {}, postMessage: (m: FromCaptionWorker) => messages.push(m) }
  vi.stubGlobal('self', worker)
  const rec: Recogniser = { streaming: false, held: 1600, accept: vi.fn(() => false), partial: () => '', result: () => '', finish: async () => { throw new Error('decoder failed') }, configure() {} }
  run(async () => rec)
  const port = { onmessage: (_e: MessageEvent) => {} }
  worker.onmessage(new MessageEvent<ToCaptionWorker>('message', { data: { type: 'init', model: 'canary-180m-flash', base: 'http://localhost/captions/', cfg: CAPTION_DEFAULTS, port: port as unknown as MessagePort } }))
  await vi.waitFor(() => expect(messages).toContainEqual({ type: 'model', status: { phase: 'ready', bytes: 0, total: 0 } }))
  port.onmessage({ data: { end: true } } as MessageEvent)
  await vi.waitFor(() => expect(messages).toContainEqual({ type: 'model', status: { phase: 'error', bytes: 0, total: 0, error: 'decoder failed' } }))
  port.onmessage({ data: { pcm: new Float32Array(960) } } as MessageEvent)
  await Promise.resolve()
  expect(rec.accept).not.toHaveBeenCalled()
})
