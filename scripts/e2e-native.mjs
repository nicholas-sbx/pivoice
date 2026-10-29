// End-to-end, the app: the Go binary doing the audio (on a fake sound card
// that beeps), its UI in Chromium, and people on the plain website in the
// same room. Checks the app and the website hear each other over both
// engines, that the app's mic test works, and that a page with the wrong
// key gets nowhere.
//
//   npm run dev                                         # terminal 1
//   (cd native && ./build.sh) && npm run e2e:native     # terminal 2
//
// NATIVE_BIN picks another build of the app (default native/pivoice).
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'

const { chromium } = createRequire(import.meta.url)('playwright')

const APP = process.env.APP_URL ?? 'http://localhost:5173/'
const BIN = process.env.NATIVE_BIN ?? 'native/pivoice'

// The app, headless: it prints the address its UI is at (with the bridge's key in the #fragment).
const app = spawn(BIN, ['--headless', '--fake-audio', '--loopback-ice', '--url', APP], { stdio: ['ignore', 'pipe', 'inherit'] })
const appUrl = await new Promise((resolve, reject) => {
  const lines = createInterface({ input: app.stdout })
  lines.on('line', line => line.startsWith('http') && resolve(line.trim()))
  app.on('exit', code => reject(new Error(`the app exited (${code}) before saying where its UI is`)))
  setTimeout(() => reject(new Error('the app never said where its UI is')), 10_000)
})

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
})
const pages = []

async function newPage(name, url) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['microphone'] })
  const page = await ctx.newPage()
  page.on('pageerror', e => console.error(`[${name}] page error:`, e.message))
  page.on('console', m => m.type() === 'error' && console.error(`[${name}]`, m.text()))
  await page.goto(url)
  pages.push(page)
  return page
}

async function enter(page, name, code = '') {
  await page.fill('input[autocomplete="nickname"]', name)
  // A code comes in through the invite link the page was opened with.
  if (code) await page.click('button:has-text("Join Room")')
  else await page.click('button:has-text("Create a Room")')
  await page.waitForSelector('.pill', { timeout: 20_000 })
}

const hears = (page, name, label) =>
  page
    .waitForFunction(
      name => [...document.querySelectorAll('.seat.speaking')].some(e => e.querySelector('.name')?.textContent.trim() === name),
      name,
      { timeout: 15_000 }
    )
    .catch(() => {
      throw new Error(`${label}: never heard ${name}`)
    })

const cardFor = (page, name) =>
  page.$$eval('.seat', (els, name) => els.find(e => e.querySelector('.name')?.textContent.trim() === name)?.querySelector('.route')?.innerText ?? '', name)

const engineOf = (page, name, re, label) =>
  page
    .waitForFunction(
      ([name, src]) => {
        const seat = [...document.querySelectorAll('.seat')].find(e => e.querySelector('.name')?.textContent.trim() === name)
        return new RegExp(src, 'i').test(seat?.querySelector('.route')?.textContent ?? '')
      },
      [name, re.source],
      { timeout: 20_000 }
    )
    .catch(async () => {
      throw new Error(`${label}: route card says ${JSON.stringify(await cardFor(page, name))}`)
    })

async function showRoute(page) {
  await page.click('button[aria-label="Display settings"]')
  await page.click('text=Show audio route')
  await page.click('button[aria-label="Display settings"]')
}

const one = s => s.replace(/\s*\n\s*/g, ' | ')
const ok = msg => console.log('✓', msg)

try {
  // A page with the wrong key gets nowhere, and says so.
  const wrong = await newPage('Wrong', appUrl.replace(/native=(\d+)\.[^&]+/, 'native=$1.' + 'x'.repeat(43)))
  await wrong.waitForSelector('text=Lost the Pivoice app', { timeout: 10_000 })
  ok('a page with the wrong key is refused')
  await wrong.context().close()

  const ada = await newPage('Ada', appUrl)
  await ada.waitForFunction(() => /app \d+\.\d+\.\d+/.test(document.querySelector('footer')?.textContent ?? ''), null, { timeout: 10_000 })
  if (/native=/.test(await ada.evaluate(() => location.href))) throw new Error("the bridge's key is still in the address bar")
  ok('the UI found the app: ' + (await ada.textContent('footer')).trim().replace(/\s+/g, ' '))

  await enter(ada, 'Ada')
  await ada.click('button[aria-label="Show room code"]')
  const code = (await ada.textContent('.bar .code-text')).trim()
  await ada.click('button[aria-label="Hide room code"]')
  ok(`Ada (in the app) made room ${code}`)

  // Ada's mic test, both paths the app has.
  await ada.click('button[aria-label="Voice Settings"]')
  if (await ada.$('.seg button:has-text("WebRTC audio")')) throw new Error('the app has no WebRTC audio path to test')
  for (const label of ['Raw', 'Low latency']) {
    await ada.click(`.seg button:has-text("${label}")`)
    if (!(await ada.$('.test-btn.stop'))) await ada.click('.test-btn')
    await ada.waitForFunction(() => /\d+ ms/.test(document.querySelector('.test-out strong')?.textContent ?? ''), null, { timeout: 15_000 }).catch(() => {
      throw new Error(`the app's mic test (${label}) never reported a latency`)
    })
    ok(`app mic test, ${label}: ` + one(await ada.$eval('.test-out', e => e.innerText)))
  }
  await ada.click('.test-btn')
  const meter = await ada.$eval('.meter .fill', e => e.style.transform)
  await ada.click('button[aria-label="Voice Settings"]')
  ok('input meter driven by the app: ' + meter)

  // Bob is on the plain website.
  const bob = await newPage('Bob', APP + '#' + code)
  await enter(bob, 'Bob', code)
  await hears(bob, 'Ada', 'Bob (website)')
  await hears(ada, 'Bob', 'Ada (app)')
  ok('the app and the website hear each other')

  await showRoute(bob)
  await showRoute(ada)
  // The website has the low-latency engine off by default (the app has it on): a plain call, Opus over RTP to the app.
  await engineOf(bob, 'Ada', /webrtc audio/, 'Bob (engine off by default), Ada over a plain call')
  await engineOf(ada, 'Bob', /webrtc audio/, 'Ada, Bob over a plain call')
  await bob.waitForTimeout(3000)
  ok('a plain call to start with: ' + one(await cardFor(ada, 'Bob')))

  // Bob turns the engine on: the pair moves over to it.
  await bob.click('button[aria-label="Voice Settings"]')
  await bob.click('button[role="tab"]:has-text("Low Latency")')
  await bob.click('text=Low-Latency Engine (Experimental)')
  await bob.click('button[aria-label="Voice Settings"]')
  await engineOf(bob, 'Ada', /low-latency engine/, 'Bob, Ada on the engine')
  await engineOf(ada, 'Bob', /low-latency engine/, 'Ada, Bob on the engine')
  await bob.waitForFunction(
    () => [...document.querySelectorAll('.route')].some(r => /pcm/i.test(r.textContent) && /mouth to ear/i.test(r.textContent)),
    null,
    { timeout: 15_000 }
  )
  await ada.waitForFunction(() => [...document.querySelectorAll('.route')].some(r => /mouth to ear/i.test(r.textContent)), null, { timeout: 15_000 })
  await bob.click('button[aria-label="Mute"]')
  await bob.click('button[aria-label="Unmute"]')
  await hears(ada, 'Bob', 'Ada (app), Bob on the engine')
  await hears(bob, 'Ada', 'Bob (website), Ada on the engine')
  ok("Bob's card for Ada: " + one(await cardFor(bob, 'Ada')))
  ok("Ada's card for Bob: " + one(await cardFor(ada, 'Bob')))

  // Ada turns on the app's echo cancellation and gain control: Bob still hears her.
  await ada.click('button[aria-label="Voice Settings"]')
  await ada.click('text=Echo Cancellation')
  await ada.click('text=Automatic Gain Control')
  await ada.click('button[aria-label="Voice Settings"]')
  await ada.click('button[aria-label="Mute"]')
  await ada.click('button[aria-label="Unmute"]')
  await hears(bob, 'Ada', 'Bob (website), Ada with processing on')
  await bob.waitForTimeout(2000)
  ok("with Ada's processing on: " + one(await cardFor(bob, 'Ada')))
  await ada.click('button[aria-label="Voice Settings"]')
  await ada.click('text=Echo Cancellation')
  await ada.click('text=Automatic Gain Control')
  await ada.click('button[aria-label="Voice Settings"]')

  // Ada turns spatial audio on (the app's Binaural: the spherical head): she still hears Bob.
  await ada.click('button[aria-label^="Spatial Audio"]')
  const spatial = await ada.getAttribute('button[aria-label^="Spatial Audio"]', 'aria-label')
  if (!/Binaural/.test(spatial ?? '')) throw new Error('spatial audio in the app should be Binaural, got ' + spatial)
  await bob.click('button[aria-label="Mute"]')
  await bob.click('button[aria-label="Unmute"]')
  await hears(ada, 'Bob', 'Ada (app, Binaural)')
  ok('Ada on Binaural: still hears Bob')
  await ada.click('button[aria-label^="Spatial Audio"]')

  // A setting that needs a fresh connection: Ada drops and comes straight back, the app's sound card closed and reopened.
  await ada.click('button[aria-label="Voice Settings"]')
  await ada.click('text=Silence Suppression (DTX)')
  await ada.click('button[aria-label="Voice Settings"]')
  await ada.waitForSelector('.status:has-text("Reconnecting")', { timeout: 5_000 }).catch(() => {})
  await ada.waitForSelector('.status:has-text("Voice Connected")', { timeout: 20_000 })
  if (await ada.$('text=nobody can hear you')) throw new Error('reconnecting lost the microphone')
  await hears(ada, 'Bob', 'Ada (app) after reconnecting')
  await hears(bob, 'Ada', 'Bob (website) after Ada reconnected')
  ok('Ada reconnected to apply a setting: same seat, mic and all')

  // Ada mutes: the app stops sending (Bob sees her bitrate go to 0).
  await ada.click('button[aria-label="Mute"]')
  await bob
    .waitForFunction(
      () => {
        const seat = [...document.querySelectorAll('.seat')].find(e => e.querySelector('.name')?.textContent.trim() === 'Ada')
        return /(^|\D)0 kbps/.test(seat?.querySelector('.route')?.textContent ?? '')
      },
      null,
      { timeout: 15_000 }
    )
    .catch(async () => {
      throw new Error('Ada muted in the app but Bob still gets audio: ' + (await cardFor(bob, 'Ada')))
    })
  ok('Ada muted: the app stopped sending')
  await ada.click('button[aria-label="Unmute"]')

  // Ada leaves; Bob's left alone, and the app is idle again.
  await ada.click('button[aria-label="Disconnect"]')
  await ada.waitForSelector('button:has-text("Create a Room")')
  await bob.waitForFunction(() => document.querySelectorAll('.seat').length === 1, null, { timeout: 20_000 })
  ok('Ada left from the app; Bob is on his own')
  console.log('\nAll good.')
} catch (e) {
  console.error('\n✗', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
  app.kill('SIGINT')
}
