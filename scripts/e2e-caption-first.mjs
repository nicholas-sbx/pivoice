// Three real Chromium peers. Captions use the existing validated data channel;
// no speech models are needed to test transcript presentation and turn-taking.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

const { chromium } = createRequire(import.meta.url)('playwright')
const APP = process.env.APP_URL ?? 'http://localhost:5173/'
const SHOTS = process.env.SHOTS_DIR ?? ''
const browser = await chromium.launch({
  executablePath: process.env.BROWSER_BIN || undefined,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
})
const errors = []
const ok = text => console.log('✓ ' + text)
let observed
async function flush(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
async function shot(page, name) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: SHOTS + '/' + name + '.png' })
}
async function open(name, code = '') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] })
  const page = await context.newPage()
  page.on('pageerror', e => errors.push(name + ': ' + e.message))
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
async function prefs(page, patch) {
  await page.evaluate(async patch => {
    const { call, updatePrefs } = await import('/src/call.ts')
    updatePrefs({ captionFirst: { ...call.prefs.captionFirst, ...patch } })
  }, patch)
  await flush(page)
}
const texts = page => page.locator('.message-text').allTextContents().then(texts => texts.map(t => t.trim()))
async function layout(page) {
  return page.evaluate(() => {
    const log = document.querySelector('.conversation')
    const bounds = el => {
      const r = el.getBoundingClientRect()
      return [r.left, r.top, r.width, r.height]
    }
    return {
      rows: [...document.querySelectorAll('.message')].map(e => [e.dataset.messageId, ...bounds(e), ...bounds(e.querySelector('.message-text'))]),
      log: [...bounds(log), log.scrollTop, log.scrollHeight, log.clientHeight],
      typing: bounds(document.querySelector('.typing-status')),
      footer: bounds(document.querySelector('.caption-footer'))
    }
  })
}
function sameLayout(before, after, label) {
  assert.equal(after.rows.length, before.rows.length, label + ': row count changed')
  for (const key of ['log', 'typing', 'footer']) {
    after[key].forEach((v, i) => assert.ok(Math.abs(v - before[key][i]) < 0.05, label + ': ' + key + '[' + i + '] moved from ' + before[key][i] + ' to ' + v))
  }
  after.rows.forEach((r, i) => r.forEach((v, k) => {
    if (k === 0) assert.equal(v, before.rows[i][k], label + ': row identity changed')
    else assert.ok(Math.abs(v - before.rows[i][k]) < 0.05, label + ': row ' + i + ' coordinate ' + k + ' moved')
  }))
}
async function oneTypingLocation(page) {
  const counts = await page.locator('.transcript .waiting-dots:visible').evaluateAll(els => {
    const counts = {}
    for (const el of els) counts[el.dataset.speaker] = (counts[el.dataset.speaker] ?? 0) + 1
    return counts
  })
  for (const [id, count] of Object.entries(counts)) assert.ok(count <= 1, id + ' is typing in ' + count + ' places')
}

try {
  const alice = observed = await open('Alice')
  const code = await alice.evaluate(() => window.__pv.call.code)
  const bob = await open('Bob', code)
  const cara = await open('Cara', code)
  await alice.waitForFunction(() => window.__pv.call.members.length === 3 && window.__pv.session().connectedCount() === 2)
  const bobId = await bob.evaluate(() => window.__pv.call.selfId)
  const caraId = await cara.evaluate(() => window.__pv.call.selfId)

  await alice.evaluate(async () => {
    const { conversation } = await import('/src/captions/state.ts')
    window.__testSpeaking = []
    window.__testEngine = window.__pv.engine()
    window.__testEngine.activity = () => ({ speaking: new Set(window.__testSpeaking), audible: new Set(window.__testSpeaking) })
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
    await flush(alice)
  }

  assert.equal(await alice.locator('.transcript').count(), 0)
  const toolbar = alice.locator('.bar button[aria-label="Transcript"]')
  assert.equal((await toolbar.textContent()).trim(), '')
  assert.ok(await toolbar.evaluate(e => e.previousElementSibling.classList.contains('people')))
  assert.equal(await toolbar.locator('svg').count(), 1)
  await toolbar.click()
  await alice.waitForSelector('.transcript.sidebar')
  assert.deepEqual(await alice.evaluate(() => {
    const p = window.__pv.call.prefs.captionFirst
    return [p.layout, p.color]
  }), ['sidebar', 'none'])
  const emptyLayout = await layout(alice)
  await speaking(bobId)
  await alice.waitForSelector('.typing-status .waiting-dots:visible')
  assert.deepEqual(await texts(alice), [])
  sameLayout(emptyLayout, await layout(alice), 'first-word waiting')
  await send(bob, 0, 'I thnk', false)
  await alice.waitForFunction(() => document.querySelector('.message-text')?.textContent === 'I thnk')
  assert.equal(await alice.locator('.typing-status .waiting-dots:visible').count(), 0)
  const firstId = await alice.locator('.message').first().getAttribute('data-message-id')
  await send(bob, 0, 'I think', false)
  await alice.waitForFunction(() => document.querySelector('.message-text')?.textContent === 'I think')
  assert.equal(await alice.locator('.message').first().getAttribute('data-message-id'), firstId)
  await speaking()
  await send(bob, 0, 'I think this works.', true)
  await speaking(bobId)
  await send(bob, 1, 'And this appends.', true)
  await alice.waitForFunction(() => document.querySelector('.message-text')?.textContent === 'I think this works. And this appends.')
  ok('icon-only Transcript follows the room count; sidebar/no colour defaults; waiting adds no blank row')

  await speaking()
  const beforeInterruption = await layout(alice)
  await speaking(caraId)
  assert.equal(await alice.locator('.message').count(), 1)
  sameLayout(beforeInterruption, await layout(alice), 'blank interruption')
  await speaking(bobId, caraId)
  await oneTypingLocation(alice)
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
  await toolbar.click()
  assert.deepEqual(await texts(alice), ['I think this works. And this appends.', 'Let me jump in.', 'Now a new message.'])
  ok('interruptions retain their order; closing restores seat captions; reopening retains the transcript')

  await speaking()
  await alice.evaluate(async () => {
    const { updateCaptions } = await import('/src/call.ts')
    updateCaptions({ lingerSec: 1 })
  })
  await alice.waitForTimeout(1300)
  assert.equal(await alice.locator('.message').count(), 3)
  await alice.click('button[aria-label="Transcript appearance and timing"]')
  assert.equal(await alice.getByRole('radio', { name: 'None', exact: true }).getAttribute('aria-checked'), 'true')
  const originalColor = await alice.locator('.message-text').first().evaluate(e => getComputedStyle(e).color)
  await alice.getByRole('radio', { name: 'Highlight', exact: true }).click()
  const highlight = await alice.locator('.message').first().evaluate(e => {
    const s = getComputedStyle(e)
    return { background: s.backgroundColor, text: getComputedStyle(e.querySelector('.message-text')).color, border: s.borderLeftWidth }
  })
  assert.equal(highlight.text, originalColor)
  assert.equal(highlight.border, '0px')
  assert.ok(highlight.background.startsWith('rgba('))
  const alpha = Number(highlight.background.slice(5, -1).split(',')[3])
  assert.ok(alpha > 0 && alpha <= 0.12)
  await alice.getByRole('radio', { name: 'Text color', exact: true }).click()
  const tinted = await alice.locator('.message-text').first().evaluate(e => getComputedStyle(e).color)
  assert.notEqual(tinted, originalColor)
  await alice.getByRole('radio', { name: 'None', exact: true }).click()
  assert.equal(await alice.locator('.message-text').first().evaluate(e => getComputedStyle(e).color), originalColor)
  await alice.locator('.appearance .slider').filter({ hasText: 'Text size' }).locator('input').fill('120')
  await alice.locator('.appearance .slider').filter({ hasText: 'Append after a pause' }).locator('input').fill('0')
  await alice.click('button[aria-label="Transcript appearance and timing"]')
  ok('None, subtle whole-message Highlight without a left bar, and Text color all work')

  await speaking(bobId)
  await send(bob, 3, 'A separate line.', true)
  await alice.waitForFunction(() => document.querySelectorAll('.message-text')[3]?.textContent === 'A separate line.')
  await speaking()
  await speaking(bobId)
  await send(bob, 4, 'Another separate line.', true)
  await alice.waitForFunction(() => document.querySelectorAll('.message-text')[4]?.textContent === 'Another separate line.')
  assert.equal(await alice.locator('.message').nth(2).locator('.avatar').count(), 1)
  for (const i of [3, 4]) {
    assert.equal(await alice.locator('.message').nth(i).locator('.avatar, .message-author').count(), 0)
    assert.match(await alice.locator('.message').nth(i).getAttribute('class'), /continuation/)
  }
  const aligned = await alice.locator('.message-text').evaluateAll(els => els.slice(2).map(e => e.getBoundingClientRect().left))
  assert.ok(aligned.every(x => Math.abs(x - aligned[0]) < 0.05))
  await speaking()
  await speaking(caraId)
  await send(cara, 1, 'Provisional words to remove.', false)
  await alice.waitForFunction(() => document.querySelectorAll('.message').length === 6)
  await send(cara, 1, '', true)
  await alice.waitForFunction(() => document.querySelectorAll('.message').length === 5)
  await oneTypingLocation(alice)
  assert.equal(await alice.locator('.waiting-dots:visible').count(), 0)
  await speaking()
  ok('consecutive messages share one avatar/name and align; an empty final removes its provisional row')

  await speaking(bobId)
  await send(bob, 5, 'An earlier live phrase.', false)
  await alice.waitForFunction(() => document.querySelectorAll('.message').length === 6)
  await speaking(caraId)
  await send(cara, 2, 'An interruption.', false)
  await alice.waitForFunction(() => document.querySelectorAll('.message').length === 7)
  await speaking(bobId, caraId)
  await oneTypingLocation(alice)
  assert.equal(await alice.locator('.message.waiting[data-speaker="' + bobId + '"]').count(), 0)
  await send(bob, 5, 'An earlier corrected phrase.', false)
  await alice.waitForFunction(() => [...document.querySelectorAll('.message-text')].some(e => e.textContent === 'An earlier corrected phrase.'))
  await oneTypingLocation(alice)
  assert.equal(await alice.locator('.message.waiting[data-speaker="' + bobId + '"]').count(), 0)
  await send(bob, 5, 'An earlier final phrase.', true)
  await send(bob, 6, 'The newest live phrase.', false)
  await alice.waitForFunction(() => document.querySelectorAll('.message-text')[7]?.textContent === 'The newest live phrase.')
  await oneTypingLocation(alice)
  assert.equal(await alice.locator('.message.waiting[data-speaker="' + bobId + '"]').count(), 1)
  await send(bob, 6, 'The newest final phrase.', true)
  await send(cara, 2, 'An interruption.', true)
  await speaking()
  ok('late partials/finals cannot reactivate an old typing indicator; each person has one typing location')

  await shot(alice, 'transcript-default-sidebar')
  for (const [width, height] of [[1440, 900], [1100, 800], [1099, 800], [900, 700], [640, 700], [390, 844], [320, 568], [844, 390]]) {
    await alice.setViewportSize({ width, height })
    await flush(alice)
    const geometry = await alice.evaluate(() => {
      const root = document.querySelector('.transcript')
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
    assert.ok(await alice.locator('.people').isVisible())
    if (width >= 1100) {
      assert.ok(geometry.tableRight <= geometry.panelLeft + 1)
      assert.ok(Math.abs(geometry.controlCenter - geometry.tableRight / 2) <= 1)
    } else assert.match(geometry.backdrop, /blur\(8px\)/)
    await shot(alice, 'transcript-' + width + 'x' + height)
  }
  ok('preferred sidebar and overlay fallback fit desktop, tablet, phone, landscape and a 320px toolbar')

  await alice.setViewportSize({ width: 1440, height: 900 })
  await prefs(alice, { layout: 'overlay' })
  assert.equal(await alice.locator('.transcript.sidebar').count(), 0)
  await shot(alice, 'transcript-overlay')
  await prefs(alice, { layout: 'sidebar', mergeSec: 30 })
  await alice.evaluate(async ({ bobId, caraId }) => {
    const { conversation, receiveCaption } = await import('/src/captions/state.ts')
    conversation.mergeMs = 0
    for (let n = 0; n < 60; n++) {
      const id = n % 2 ? caraId : bobId
      conversation.activity(new Set([id]), performance.now())
      receiveCaption(id, JSON.stringify({ v: 1, s: 42, u: 100 + n, t: 'Message ' + n + ': ' + 'Some words for the conversation. '.repeat(6), f: true }))
    }
    conversation.activity(new Set(), performance.now())
    conversation.mergeMs = 30_000
  }, { bobId, caraId })
  await flush(alice)
  assert.ok(await alice.locator('.conversation').evaluate(e => e.scrollHeight > e.clientHeight + 1000))

  // Keep the text identical while switching between idle, inline typing,
  // hidden dots and expired waiting. Compare every row, not just the panel.
  for (const width of [320, 390, 1100]) {
    await alice.setViewportSize({ width, height: 750 })
    for (const scale of [1, 1.25, 1.75]) {
      await prefs(alice, { scale, mergeSec: 30, indicator: true })
      await flush(alice)
      const before = await layout(alice)
      await speaking(caraId)
      await oneTypingLocation(alice)
      sameLayout(before, await layout(alice), width + 'px / ' + scale + ' starting')
      await prefs(alice, { indicator: false })
      sameLayout(before, await layout(alice), width + 'px / ' + scale + ' hiding dots')
      await prefs(alice, { indicator: true })
      await speaking()
      await alice.evaluate(async () => {
        const { conversation } = await import('/src/captions/state.ts')
        conversation.tick(performance.now() + conversation.waitMs + 1)
      })
      await flush(alice)
      sameLayout(before, await layout(alice), width + 'px / ' + scale + ' stopping')
    }
  }
  ok('no row height, position or scroll movement when typing starts/stops at 320/390/1100px and 100/125/175% text size')

  await alice.setViewportSize({ width: 1440, height: 900 })
  await prefs(alice, { scale: 1.2, mergeSec: 10 })
  await alice.locator('.conversation').evaluate(e => { e.scrollTop = 0; e.dispatchEvent(new Event('scroll')) })
  await alice.getByRole('button', { name: /Jump to latest/ }).waitFor()
  await send(bob, 200, 'Do not pull the reader away from their place.', true)
  await alice.waitForTimeout(100)
  assert.equal(await alice.locator('.conversation').evaluate(e => e.scrollTop), 0)
  await alice.getByRole('button', { name: /Jump to latest/ }).click()
  assert.ok(await alice.locator('.conversation').evaluate(e => e.scrollHeight - e.scrollTop - e.clientHeight < 5))
  assert.ok(await alice.evaluate(() => window.__pv.engine() === window.__testEngine))
  const saved = await alice.evaluate(() => JSON.parse(localStorage.getItem('pv.prefs')).captionFirst)
  assert.equal(saved.layout, 'sidebar')
  assert.equal(saved.color, 'none')
  assert.equal(saved.scale, 1.2)
  await alice.getByRole('button', { name: 'Mute', exact: true }).click()
  await alice.getByRole('button', { name: 'Unmute', exact: true }).waitFor()
  await alice.locator('.caption-panel').focus()
  await alice.keyboard.press('Escape')
  assert.equal(await alice.locator('.transcript').count(), 0)
  assert.equal(await alice.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Transcript')
  await toolbar.click()
  await alice.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await alice.getByRole('button', { name: /^Create a Room/ }).waitFor()
  const remaining = await alice.evaluate(async () => (await import('/src/captions/state.ts')).conversation.messages.length)
  assert.equal(remaining, 0)
  assert.deepEqual(errors, [])
  ok('scrollback stays put; preferences persist; the same audio engine remains; mute/Escape/disconnect work without page errors')
} catch (error) {
  if (observed) await shot(observed, 'failure').catch(() => {})
  console.error('Page errors:', errors)
  throw error
} finally {
  await browser.close()
}
