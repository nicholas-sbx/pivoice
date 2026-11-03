// End-to-end live captions: two Chromiums in a room, one whose fake
// microphone is someone reading out digits (tests/fixtures/speech.wav), and
// the other watching for their words to turn up beside their seat.
//
//   node scripts/captions-models.mjs   # once: the models, into public/captions/
//   npm run dev                        # terminal 1
//   npm run e2e:captions               # terminal 2
//
// The speaker's browser downloads the model from the dev server like anyone
// would, recognises itself, and sends the words over the captions channel:
// first with Vosk (the default), then with Parakeet.
//
// Then, if the app's built (native/pivoice, or NATIVE_BIN), the same with the
// app as the speaker: headless, its fake mic reading the same digits
// (--fake-mic), recognising natively in its helper process, with the
// recognisers fetched from their releases into a cache folder of this run's
// own (XDG_CACHE_HOME), and the words reaching the website over pion's end
// of the captions channel.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const { chromium } = createRequire(import.meta.url)('playwright')
const APP = process.env.APP_URL ?? 'http://localhost:5173/'
const SPEECH = fileURLToPath(new URL('../tests/fixtures/speech.wav', import.meta.url))
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIGITS = /\b(zero|one|two|three|four|five|six|seven|eight|nine|oh|no)\b/i
const BIN = process.env.NATIVE_BIN ?? `${ROOT}/native/pivoice`

if (!existsSync(`${ROOT}/public/captions/vosk-small-en/manifest.json`)) {
  console.error('No models in public/captions: run `node scripts/captions-models.mjs` first.')
  process.exit(1)
}

const base = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
const quiet = await chromium.launch({ args: base })
const speaking = await chromium.launch({ args: [...base, `--use-file-for-fake-audio-capture=${SPEECH}`] })

async function open(browser, name, prefs, code = '', url = '') {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['microphone'] })
  const page = await ctx.newPage()
  await page.addInitScript(p => localStorage.setItem('pv.prefs', JSON.stringify(p)), prefs)
  page.on('pageerror', e => console.error(`[${name}] page error:`, e.message))
  page.on('console', m => {
    if (m.type() === 'error' || /captions/i.test(m.text())) console.log(`[${name}]`, m.text())
  })
  await page.goto(url || APP + (code ? '#' + code : ''))
  await page.fill('input[autocomplete="nickname"]', name)
  await page.click(code ? 'button:has-text("Join Room")' : 'button:has-text("Create a Room")')
  await page.waitForSelector('.pill', { timeout: 20_000 })
  return page
}

const ok = msg => console.log('✓', msg)

/** What the listener sees beside the speaker, once it has some digits in it. */
async function heard(page, label, timeout = 180_000) {
  const at = Date.now()
  for (;;) {
    const text = await page.$$eval('.seat:not(.self) .caption', els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()).join(' | '))
    if (DIGITS.test(text)) return text
    if (Date.now() - at > timeout) throw new Error(`${label}: no captions with words in them after ${timeout / 1000} s (saw "${text}")`)
    await page.waitForTimeout(500)
  }
}

async function settingsTab(page) {
  if (!(await page.$('.panel'))) await page.click('button[aria-label="Voice Settings"]')
  await page.click('.tabs button:has-text("Captions")')
}

try {
  const alice = await open(quiet, 'Alice', { name: 'Alice', captions: { send: false } })
  await alice.click('button[aria-label="Show room code"]')
  const code = (await alice.textContent('.bar .code-text')).trim()
  const bob = await open(speaking, 'Bob', { name: 'Bob' }, code)
  ok(`Alice and Bob in room ${code}; Bob's mic is someone reading digits`)

  // Bob's settings say what his captions hear and how the model's getting on.
  await settingsTab(bob)
  await bob.waitForFunction(() => /Ready/.test(document.querySelector('.captions-tab .status')?.textContent ?? ''), null, { timeout: 180_000 }).catch(async () => {
    throw new Error('Vosk never got ready: ' + (await bob.textContent('.captions-tab .status')))
  })
  ok('Bob: ' + (await bob.$eval('.captions-tab .status', e => e.innerText.replace(/\s+/g, ' ').trim())))
  ok('Bob: ' + (await bob.$eval('.captions-tab .hearing', e => e.innerText.replace(/\s+/g, ' ').trim())))

  ok('Vosk, beside Bob on Alice’s screen: ' + (await heard(alice, 'Vosk')))

  // Parakeet: the same, recognised a phrase at a time.
  await bob.click('.captions-tab .model:has-text("Parakeet")')
  await bob.waitForFunction(() => /Ready/.test(document.querySelector('.captions-tab .status')?.textContent ?? ''), null, { timeout: 300_000 }).catch(async () => {
    throw new Error('Parakeet never got ready: ' + (await bob.textContent('.captions-tab .status')))
  })
  ok('Bob: ' + (await bob.$eval('.captions-tab .status', e => e.innerText.replace(/\s+/g, ' ').trim())))
  // What showed before was Vosk's; wait for it to clear, then for Parakeet's.
  await alice.waitForFunction(() => !document.querySelector('.seat:not(.self) .caption'), null, { timeout: 30_000 }).catch(() => {})
  ok('Parakeet, beside Bob on Alice’s screen: ' + (await heard(alice, 'Parakeet')))

  // Muted: nothing is recognised, and nothing new is said.
  await bob.click('button[aria-label="Mute"]')
  await alice.waitForFunction(() => !document.querySelector('.seat:not(.self) .caption'), null, { timeout: 30_000 }).catch(() => {
    throw new Error('captions kept coming while Bob was muted')
  })
  ok('Bob muted: his captions stop')

  if (!existsSync(BIN)) console.log(`- the app: no ${BIN} (build it: cd native && ./build.sh), skipped`)
  else await theApp(alice, code)
  console.log('\nAll good.')
} catch (e) {
  console.error('\n✗', e.message)
  process.exitCode = 1
} finally {
  await quiet.close()
  await speaking.close()
  app?.kill()
}

let app = null

/** The app as the speaker: Cleo, recognised natively, seen on Alice's (website) screen. */
async function theApp(alice, code) {
  const cache = mkdtempSync(join(tmpdir(), 'pivoice-captions-'))
  // The room code as the app's argument: its page opens with it, as an invite link would.
  app = spawn(BIN, ['--headless', '--fake-audio', `--fake-mic=${SPEECH}`, '--loopback-ice', '--url', APP, code], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, XDG_CACHE_HOME: cache }
  })
  const url = await new Promise((resolve, reject) => {
    createInterface({ input: app.stdout }).on('line', line => line.startsWith('http') && resolve(line.trim()))
    app.on('exit', c => reject(new Error(`the app exited (${c})`)))
    setTimeout(() => reject(new Error('the app never said where its UI is')), 10_000)
  })
  const cleo = await open(quiet, 'Cleo', { name: 'Cleo' }, code, url)
  ok(`Cleo (the app, reading digits) joined room ${code}`)
  await settingsTab(cleo)
  await cleo.waitForFunction(() => /Ready/.test(document.querySelector('.captions-tab .status')?.textContent ?? ''), null, { timeout: 300_000 }).catch(async () => {
    throw new Error('the app’s Vosk never got ready: ' + (await cleo.textContent('.captions-tab .status')))
  })
  ok('Cleo: ' + (await cleo.$eval('.captions-tab .status', e => e.innerText.replace(/\s+/g, ' ').trim())))
  ok('Cleo: ' + (await cleo.$eval('.captions-tab .hearing', e => e.innerText.replace(/\s+/g, ' ').trim())))
  ok('the app’s Vosk, beside Cleo on Alice’s screen: ' + (await heardFrom(alice, cleo, 'the app’s Vosk')))
  await cleo.click('.captions-tab .model:has-text("Parakeet")')
  await cleo.waitForFunction(() => /Ready/.test(document.querySelector('.captions-tab .status')?.textContent ?? ''), null, { timeout: 300_000 }).catch(async () => {
    throw new Error('the app’s Parakeet never got ready: ' + (await cleo.textContent('.captions-tab .status')))
  })
  await alice.waitForTimeout(7_000)
  ok('the app’s Parakeet, beside Cleo on Alice’s screen: ' + (await heardFrom(alice, cleo, 'the app’s Parakeet')))
  ok('Cleo: ' + (await cleo.$eval('.captions-tab .status', e => e.innerText.replace(/\s+/g, ' ').trim())))
}

/** What `page` shows beside `who`'s seat, once it has digits in it. */
async function heardFrom(page, who, label, timeout = 180_000) {
  const id = await who.evaluate(() => document.querySelector('.seat.self')?.dataset.member)
  const at = Date.now()
  for (;;) {
    const text = await page.$$eval(`.seat[data-member="${id}"] .caption`, els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()).join(' | '))
    if (DIGITS.test(text)) return text
    if (Date.now() - at > timeout) throw new Error(`${label}: no captions with words in them after ${timeout / 1000} s (saw "${text}")`)
    await page.waitForTimeout(500)
  }
}
