// Three real Chromium peers, with deterministic caption updates sent over the
// existing captions data channel. No models needed: this checks presentation,
// turn-taking, corrections, responsive layout, persistence and call controls.
// npm run dev, then npm run e2e:caption-first (Playwright installed separately).
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

const { chromium } = createRequire(import.meta.url)('playwright')
const APP = process.env.APP_URL ?? 'http://localhost:5173/'
const browser = await chromium.launch({
  executablePath: process.env.BROWSER_BIN || undefined,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
})
const errors = []
const ok = text => console.log('✓ ' + text)
async function open(name, code = '') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] })
  const page = await context.newPage()
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`))
  await page.addInitScript(() => localStorage.setItem('pv.prefs', JSON.stringify({ captions: { send: false }, appBannerDismissed: true })))
  await page.goto(APP + (code ? '#' + code : ''))
  await page.fill('input[autocomplete="nickname"]', name)
  await page.click(code ? 'button:has-text("Join Room")' : 'button:has-text("Create a Room")')
  await page.waitForSelector('.pill', { timeout: 20_000 })
  return page
}
async function send(page, u, t, f) {
  await page.evaluate(({ u, t, f }) => window.__pv.session().sendCaption(JSON.stringify({ v: 1, s: 42, u, t, f })), { u, t, f })
}
const texts = page => page.locator('.message-text').allTextContents().then(texts => texts.map(t => t.trim()))

try {
  const alice = await open('Alice')
  const code = await alice.evaluate(() => window.__pv.call.code)
  const bob = await open('Bob', code)
  const cara = await open('Cara', code)
  await alice.waitForFunction(() => window.__pv.call.members.length === 3 && window.__pv.session().connectedCount() === 2)
  const bobId = await bob.evaluate(() => window.__pv.call.selfId)
  const caraId = await cara.evaluate(() => window.__pv.call.selfId)

  // Use deterministic ring edges on the receiving screen. Audio and real peer
  // connections keep running; the fake microphones otherwise beep at random.
  await alice.evaluate(async () => {
    const { conversation } = await import('/src/captions/state.ts')
    window.__testSpeaking = []
    window.__pv.engine().activity = () => ({ speaking: new Set(window.__testSpeaking), audible: new Set(window.__testSpeaking) })
    window.__pv.call.speaking = new Set()
    conversation.clear()
    conversation.roster(window.__pv.call.members)
  })
  async function speaking(...ids) {
    await alice.evaluate(ids => { window.__testSpeaking = ids }, ids)
    await alice.waitForFunction(ids => {
      const s = window.__pv.call.speaking
      return s.size === ids.length && ids.every(id => s.has(id))
    }, ids)
  }
  assert.equal(await alice.locator('.captions-first').count(), 0)
  await alice.click('button[aria-label="Captions first"]')
  await speaking(bobId)
  await alice.waitForSelector('.message .waiting-dots')
  assert.deepEqual(await texts(alice), [''])
  await send(bob, 0, 'I thnk', false)
  await alice.waitForFunction(() => document.querySelector('.message-text')?.textContent === 'I thnk')
  const firstId = await alice.locator('.message').first().getAttribute('data-message-id')
  await send(bob, 0, 'I think', false)
  await alice.waitForFunction(() => document.querySelector('.message-text')?.textContent === 'I think')
  assert.equal(await alice.locator('.message').first().getAttribute('data-message-id'), firstId)
  await speaking()
  await send(bob, 0, 'I think this works.', true)
  await speaking(bobId)
  await send(bob, 1, 'And this appends.', true)
  await alice.waitForFunction(() => document.querySelector('.message-text')?.textContent === 'I think this works. And this appends.')
  ok('blank waiting row, live corrections and a resumed speaker all update the same message')

  await speaking()
  await speaking(caraId)
  await alice.waitForFunction(() => document.querySelectorAll('.message').length === 2)
  await speaking(bobId, caraId)
  await send(cara, 0, 'Let me jump in.', true)
  await send(bob, 2, 'Now a new message.', true)
  await alice.waitForFunction(() => document.querySelectorAll('.message-text')[2]?.textContent === 'Now a new message.')
  assert.deepEqual(await texts(alice), ['I think this works. And this appends.', 'Let me jump in.', 'Now a new message.'])
  const colors = await alice.locator('.message').evaluateAll(els => els.map(e => e.style.getPropertyValue('--speaker-color')))
  assert.equal(colors[0], colors[2])
  assert.notEqual(colors[0], colors[1])
  assert.equal(await alice.locator('.table-stage .caption').count(), 0)
  await alice.click('button[aria-label="Return to table"]')
  await alice.waitForSelector('.table-stage .caption')
  assert.equal(await alice.locator('button[aria-label="Captions first"]').getAttribute('aria-pressed'), 'false')
  await alice.click('button[aria-label="Captions first"]')
  assert.deepEqual(await texts(alice), ['I think this works. And this appends.', 'Let me jump in.', 'Now a new message.'])
  ok('interruption interleaves before the first word; closing restores table captions and reopening retains history')

  await speaking()
  await alice.evaluate(async () => {
    const { updateCaptions } = await import('/src/call.ts')
    updateCaptions({ lingerSec: 1 })
  })
  await alice.waitForTimeout(1300)
  assert.equal(await alice.locator('.message').count(), 3)
  ok('conversation outlives the seat captions')

  if (process.env.SHOTS_DIR) {
    mkdirSync(process.env.SHOTS_DIR, { recursive: true })
    await alice.screenshot({ path: `${process.env.SHOTS_DIR}/captions-first-overlay-desktop.png` })
  }

  await alice.click('button[aria-label="Caption appearance and timing"]')
  await alice.getByRole('radio', { name: 'Sidebar when it fits', exact: true }).click()
  await alice.locator('.appearance .slider').filter({ hasText: 'Text size' }).locator('input').fill('120')
  await alice.click('button[aria-label="Caption appearance and timing"]')
  for (const [width, height] of [[1440, 900], [1100, 800], [1099, 800], [900, 700], [640, 700], [390, 844], [320, 568], [844, 390]]) {
    await alice.setViewportSize({ width, height })
    await alice.waitForTimeout(150)
    const geometry = await alice.evaluate(() => {
      const root = document.querySelector('.captions-first')
      const table = document.querySelector('.table-stage')
      const panel = document.querySelector('.caption-panel').getBoundingClientRect()
      const log = document.querySelector('.conversation').getBoundingClientRect()
      const controls = [...document.querySelectorAll('.bar button, .pill button')].map(e => e.getBoundingClientRect())
      const left = document.querySelector('.bar .left')
      const pill = document.querySelector('.pill').getBoundingClientRect()
      return {
        sidebar: root.classList.contains('sidebar'), inert: table.inert,
        wide: document.documentElement.scrollWidth > innerWidth,
        tall: document.documentElement.scrollHeight > innerHeight,
        panelFits: panel.left >= 0 && panel.right <= innerWidth && panel.bottom <= innerHeight && log.height > 20,
        controlsFit: controls.every(r => r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight),
        headerFits: left.scrollWidth <= Math.ceil(left.clientWidth),
        controlCenter: (pill.left + pill.right) / 2,
        backdrop: getComputedStyle(root, '::before').backdropFilter,
        tableRight: table.getBoundingClientRect().right, panelLeft: panel.left
      }
    })
    assert.equal(geometry.sidebar, width >= 1100, JSON.stringify({ width, geometry }))
    assert.equal(geometry.inert, width < 1100)
    assert.ok(!geometry.wide && !geometry.tall && geometry.panelFits && geometry.controlsFit && geometry.headerFits, JSON.stringify({ width, height, geometry }))
    if (width >= 1100) {
      assert.ok(geometry.tableRight <= geometry.panelLeft + 1)
      assert.ok(Math.abs(geometry.controlCenter - geometry.tableRight / 2) <= 1, JSON.stringify({ width, geometry }))
    }
    else assert.match(geometry.backdrop, /blur\(8px\)/)
    if (process.env.SHOTS_DIR) {
      mkdirSync(process.env.SHOTS_DIR, { recursive: true })
      await alice.screenshot({ path: `${process.env.SHOTS_DIR}/captions-first-${width}x${height}.png` })
    }
  }
  ok('sidebar at 1100px and above; blurred overlay on tablets, phones and landscape; controls fit at 320px')

  await alice.setViewportSize({ width: 1440, height: 900 })
  await alice.evaluate(async ({ bobId, caraId }) => {
    const { receiveCaption } = await import('/src/captions/state.ts')
    for (let u = 3; u < 65; u++) {
      const id = u % 2 ? bobId : caraId
      // Directly feed the same validated receiver for a long, deterministic scrollback.
      receiveCaption(id, JSON.stringify({ v: 1, s: 42, u, t: `Message ${u}: ${'Some words for the conversation. '.repeat(6)}`, f: true }))
    }
  }, { bobId, caraId })
  await alice.waitForTimeout(100)
  await alice.locator('.conversation').evaluate(e => { e.scrollTop = 0; e.dispatchEvent(new Event('scroll')) })
  await alice.getByRole('button', { name: /Jump to latest/ }).waitFor()
  await send(bob, 65, 'Do not pull the reader away from their place.', true)
  await alice.waitForTimeout(100)
  assert.equal(await alice.locator('.conversation').evaluate(e => e.scrollTop), 0)
  await alice.getByRole('button', { name: /Jump to latest/ }).click()
  assert.ok(await alice.locator('.conversation').evaluate(e => e.scrollHeight - e.scrollTop - e.clientHeight < 5))
  ok('scrollback stays put while reading; Jump to latest resumes following')

  const saved = await alice.evaluate(() => JSON.parse(localStorage.getItem('pv.prefs')).captionFirst)
  assert.equal(saved.layout, 'sidebar')
  assert.equal(saved.scale, 1.2)
  await alice.getByRole('button', { name: 'Mute', exact: true }).click()
  await alice.getByRole('button', { name: 'Unmute', exact: true }).waitFor()
  await alice.locator('.caption-panel').focus()
  await alice.keyboard.press('Escape')
  assert.equal(await alice.locator('.captions-first').count(), 0)
  assert.equal(await alice.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Captions first')
  await alice.click('button[aria-label="Captions first"]')
  await alice.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await alice.getByRole('button', { name: /^Create a Room/ }).waitFor()
  const remaining = await alice.evaluate(async () => (await import('/src/captions/state.ts')).conversation.messages.length)
  assert.equal(remaining, 0)
  assert.deepEqual(errors, [])
  ok('preferences persist, mute/disconnect work, Escape restores focus, and leaving clears history; no page errors')
} finally {
  await browser.close()
}
