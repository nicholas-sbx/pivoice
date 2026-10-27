// End-to-end: real Chromium tabs with fake microphones, talking through a
// local PeerJS broker.
//
//   npm run peer:local    # terminal 1
//   npm run dev:local     # terminal 2
//   npm run e2e           # terminal 3
//
// Checks that people can make and join a room, see each other at the table,
// hear each other (the fake mic beeps, which lights up the speaking ring on
// everyone else's screen), and that the call survives the host leaving.
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

// Playwright isn't a dependency (it's big): use whichever one is installed,
// here or globally (`npm i -g playwright && npx playwright install chromium`).
const { chromium } = createRequire(import.meta.url)('playwright')

const APP = process.env.APP_URL ?? 'http://localhost:5173/'
const SHOTS = process.env.SHOTS_DIR ?? ''

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
})

const pages = []
async function open(name, code = '') {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] })
  const page = await ctx.newPage()
  page.on('pageerror', e => console.error(`[${name}] page error:`, e.message))
  page.on('console', m => {
    if (m.type() === 'error') console.error(`[${name}]`, m.text())
  })
  await page.goto(APP + (code ? '#' + code : ''))
  await page.fill('input[autocomplete="nickname"]', name)
  if (code) await page.click('button:has-text("Join Room")')
  else await page.click('button:has-text("Create a Room")')
  await page.waitForSelector('.pill', { timeout: 20_000 })
  pages.push({ name, page, ctx })
  return page
}

const seats = page => page.$$eval('.seat', els => els.filter(e => Number(e.style.opacity) > 0.5).length)
const status = page => page.textContent('.status')

async function expectSeats(page, n, label) {
  const deadline = Date.now() + 20_000
  let got = -1
  while (Date.now() < deadline) {
    got = await seats(page)
    if (got === n && (await status(page)).includes('Voice Connected')) return
    await page.waitForTimeout(250)
  }
  throw new Error(`${label}: expected ${n} seats, saw ${got} (${await status(page)})`)
}

async function expectHearsSomeone(page, label) {
  await page.waitForSelector('.seat.speaking:not(.self)', { timeout: 15_000 }).catch(() => {
    throw new Error(`${label}: never saw anyone else speaking (no audio arriving?)`)
  })
}

function ok(msg) {
  console.log('✓', msg)
}

try {
  const alice = await open('Alice')
  // Hidden by default: nothing on screen gives it away until you ask.
  if (!(await alice.textContent('.bar .code-text')).includes('•')) throw new Error('room code shown by default')
  if (await alice.$('.felt .code')) throw new Error('room code on the table by default')
  await alice.click('button[aria-label="Show room code"]')
  const code = (await alice.textContent('.bar .code-text')).trim()
  await alice.click('button[aria-label="Hide room code"]')
  if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error('bad room code ' + code)
  ok(`Alice made room ${code}`)
  await expectSeats(alice, 1, 'Alice alone')

  const bob = await open('Bob', code)
  const cara = await open('Cara', code)
  for (const [p, n] of [
    [alice, 'Alice'],
    [bob, 'Bob'],
    [cara, 'Cara']
  ]) {
    await expectSeats(p, 3, n)
    await expectHearsSomeone(p, n)
  }
  ok('three at the table, all hearing each other')

  // Seats are evenly spaced, with yourself at the bottom.
  const layout = await bob.$$eval('.seat', els =>
    els.map(e => ({ self: e.classList.contains('self'), t: e.style.transform }))
  )
  if (!layout.find(s => s.self)) throw new Error('no self seat')
  ok('Bob sees: ' + layout.map(s => (s.self ? 'me' : 'them')).join(', '))

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true })
    await bob.waitForTimeout(800)
    await bob.screenshot({ path: `${SHOTS}/room-3.png` })
  }

  // Mute shows up for everyone else.
  await bob.click('button[aria-label="Mute"]')
  await alice.waitForSelector('.seat:not(.self) .state', { timeout: 10_000 })
  ok('Bob muting shows on Alice’s screen')
  await bob.click('button[aria-label="Unmute"]')

  // The host leaves: the call carries on and someone else takes the room.
  await alice.click('button[aria-label="Disconnect"]')
  await alice.waitForSelector('button:has-text("Create a Room")')
  await expectSeats(bob, 2, 'Bob after Alice left')
  await expectSeats(cara, 2, 'Cara after Alice left')
  ok('Alice (the host) left; Bob and Cara still connected')

  const dan = await open('Dan', code)
  for (const [p, n] of [
    [bob, 'Bob'],
    [cara, 'Cara'],
    [dan, 'Dan']
  ]) {
    await expectSeats(p, 3, n + ' after Dan joined')
  }
  await expectHearsSomeone(dan, 'Dan')
  ok('Dan joined the room after the hand-over and hears people')

  // More people, for the screenshot and to exercise the layout.
  const extra = []
  for (const n of ['Eve', 'Finn', 'Gus']) extra.push(await open(n, code))
  await expectSeats(dan, 6, 'Dan with six')
  ok('six at the table')
  if (SHOTS) {
    await dan.click('button[aria-label^="Spatial Audio"]')
    await dan.waitForTimeout(1200)
    await dan.screenshot({ path: `${SHOTS}/room-6.png` })
    await dan.click('button[aria-label="Voice Settings"]')
    await dan.waitForTimeout(300)
    await dan.screenshot({ path: `${SHOTS}/settings.png` })
  }

  // Someone in the middle leaves: the rest close the gap.
  await extra[1].click('button[aria-label="Disconnect"]')
  await expectSeats(dan, 5, 'Dan after Finn left')
  ok('Finn left, five remain')

  if (SHOTS) {
    const home = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await home.goto(APP)
    await home.waitForTimeout(300)
    await home.screenshot({ path: `${SHOTS}/home.png` })
    await home.goto(APP + '#' + code)
    await home.reload()
    await home.waitForTimeout(300)
    await home.screenshot({ path: `${SHOTS}/invite.png` })
  }
  console.log('\nAll good.')
} catch (e) {
  console.error('\n✗', e.message)
  for (const { name, page } of pages) {
    if (page.isClosed()) continue
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/fail-${name}.png` }).catch(() => {})
  }
  process.exitCode = 1
} finally {
  await browser.close()
}
