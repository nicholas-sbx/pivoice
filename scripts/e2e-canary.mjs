// The real Canary INT8 models through the production browser worker, its
// downloader, cache and 48 -> 16 kHz audio path. Needs `npm run dev` and
// `npm run captions:models -- --model canary-180m-flash` first.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const { chromium } = createRequire(import.meta.url)('playwright')
const APP = process.env.APP_URL ?? 'http://localhost:5173/'
const wav = readFileSync(new URL('../tests/fixtures/speech.wav', import.meta.url)).toString('base64')
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.on('pageerror', e => console.error(e.message))
  await page.goto(APP)
  const result = await page.evaluate(async ({ wav }) => {
    const { default: CaptionWorker } = await import('/src/captions/canary.worker.ts?worker')
    const bytes = Uint8Array.from(atob(wav), c => c.charCodeAt(0))
    const audio = new OfflineAudioContext(1, 1, 48_000)
    const buffer = await audio.decodeAudioData(bytes.buffer)
    const pcm = buffer.getChannelData(0)
    const runs = []
    for (let run = 0; run < 2; run++) {
      const worker = new CaptionWorker()
      const { port1, port2 } = new MessageChannel()
      const phases = []
      const texts = []
      let error = ''
      let ready = false
      worker.onerror = e => error = e.message
      worker.onmessage = ({ data }) => {
        if (data.type === 'model') {
          const status = data.status
          if (phases.at(-1) !== status.phase) phases.push(status.phase)
          if (status.phase === 'needed') worker.postMessage({ type: 'download' })
          if (status.phase === 'error') error = status.error
          if (status.phase === 'ready') ready = true
        } else if (data.type === 'text') texts.push(data)
      }
      const until = async (condition, label) => {
        const until = Date.now() + 180_000
        while (!condition()) {
          if (error) throw new Error(error)
          if (Date.now() > until) throw new Error(`${label}: ${phases.join(', ')}; ${JSON.stringify(texts)}`)
          await new Promise(r => setTimeout(r, 50))
        }
      }
      const send = (from, to) => {
        for (let at = from; at < to; at += 960) {
          const frame = pcm.slice(at, Math.min(at + 960, to))
          port1.postMessage({ pcm: frame }, [frame.buffer])
        }
      }
      try {
        worker.postMessage({ type: 'init', model: 'canary-180m-flash', base: new URL('captions/', document.baseURI).href,
          cfg: { language: 'en', partials: true, partialsPerSec: 8, rereadMs: 1000, maxPhraseSec: 15, minConfidence: 0 }, port: port2 }, [port2])
        await until(() => ready, 'model load')
        if (texts.length) throw new Error('captioned without any audio')
        // Wait for a genuine live re-read, then finish the phrase.
        send(0, 48_000 * 2)
        await until(() => texts.some(t => !t.final), 'partial transcript')
        send(48_000 * 2, pcm.length)
        port1.postMessage({ end: true })
        await until(() => texts.some(t => t.final), 'final transcript')
        // The same phrase again: the decimator and decoder caches must reset.
        send(0, pcm.length)
        port1.postMessage({ end: true })
        await until(() => texts.filter(t => t.final).length === 2, 'second phrase')
        runs.push({ phases, texts })
      } finally {
        worker.terminate()
        port1.close()
      }
    }
    return runs
  }, { wav })
  assert(result[0].phases.includes('downloading'), 'fresh browser downloads the pinned model')
  assert(!result[1].phases.includes('needed'), 'second worker uses the checked cache')
  for (const run of result) {
    const finals = run.texts.filter(t => t.final)
    for (const { text } of finals) {
      assert((text.match(/\b(zero|one|two|three|four|five|six|seven|eight|nine|oh)\b/gi) ?? []).length >= 5, `expected spoken digits: ${text}`)
      assert(!text.includes('<|'), `control tokens in captions: ${text}`)
    }
    assert.equal(finals[0].text, finals[1].text, 'fresh phrase has no decoder history')
    assert.equal(finals[1].u, finals[0].u + 1, 'new phrase is numbered separately')
  }
  console.log('Canary browser worker: live and final transcripts, phrase reset, verified download and cache reload passed.')
  console.log(JSON.stringify(result, null, 2))
} finally {
  await browser.close()
}
