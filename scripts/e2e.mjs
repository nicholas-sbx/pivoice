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

  // Ping beside everyone else, from the calls' own stats.
  await dan.waitForSelector('.seat:not(.self) .ping', { timeout: 10_000 }).catch(() => {
    throw new Error('no ping shown')
  })
  ok('ping shows: ' + (await dan.$$eval('.seat:not(.self) .ping', els => els.map(e => e.textContent.trim()).join(', '))))

  if (SHOTS) {
    await dan.click('button[aria-label^="Spatial Audio"]')
    await dan.waitForTimeout(1200)
    await dan.screenshot({ path: `${SHOTS}/room-6.png` })
    await dan.click('button[aria-label="Voice Settings"]')
    await dan.waitForTimeout(300)
    await dan.screenshot({ path: `${SHOTS}/settings.png` })
  }

  // The route card, behind the toggle in the top bar.
  if (await dan.$('.route')) throw new Error('route card shown by default')
  await dan.click('button[aria-label="Display settings"]')
  await dan.click('text=Show audio route')
  await dan.click('button[aria-label="Display settings"]')
  await dan.waitForSelector('.route .route-head:not(:has-text("Connecting"))', { timeout: 10_000 })
  await dan.waitForFunction(() => [...document.querySelectorAll('.route')].some(r => r.textContent.includes('mouth to ear')), null, { timeout: 10_000 })
  ok('route card: ' + (await dan.$eval('.route', e => e.innerText.replace(/\s*\n\s*/g, ' | '))))
  // Muting stops the packets, not just the sound: Eve's bitrate on Dan's screen drops to nothing.
  const kbpsOf = name =>
    dan.$$eval(
      '.seat',
      (els, name) => {
        const seat = els.find(e => e.querySelector('.name')?.textContent.trim() === name)
        const m = seat?.querySelector('.route')?.textContent.match(/(\d+) kbps/)
        return m ? Number(m[1]) : null
      },
      name
    )
  await extra[0].click('button[aria-label="Mute"]')
  await dan.waitForFunction(
    () => {
      const seat = [...document.querySelectorAll('.seat')].find(e => e.querySelector('.name')?.textContent.trim() === 'Eve')
      return /(^|\D)0 kbps/.test(seat?.querySelector('.route')?.textContent ?? '')
    },
    null,
    { timeout: 10_000 }
  ).catch(async () => {
    throw new Error(`Eve muted but still sending (${await kbpsOf('Eve')} kbps)`)
  })
  ok('Eve muted: 0 kbps reaching Dan')
  await extra[0].click('button[aria-label="Unmute"]')
  await dan.waitForFunction(
    () => {
      const seat = [...document.querySelectorAll('.seat')].find(e => e.querySelector('.name')?.textContent.trim() === 'Eve')
      const m = seat?.querySelector('.route')?.textContent.match(/(\d+) kbps/)
      return m && Number(m[1]) > 0
    },
    null,
    { timeout: 10_000 }
  )
  ok(`Eve unmuted: ${await kbpsOf('Eve')} kbps again`)

  // Deafened: everyone else stops sending to you.
  await dan.click('button[aria-label="Deafen"]')
  await dan.waitForFunction(
    () => {
      const cards = [...document.querySelectorAll('.seat:not(.self) .route')]
      return cards.length > 0 && cards.every(c => /(^|\D)0 kbps/.test(c.textContent))
    },
    null,
    { timeout: 10_000 }
  ).catch(() => {
    throw new Error('Dan deafened but people are still sending to him')
  })
  ok('Dan deafened: nobody sends him audio')
  await dan.click('button[aria-label="Undeafen"]')
  await dan.waitForFunction(
    () => [...document.querySelectorAll('.seat:not(.self) .route')].some(c => /[1-9]\d* kbps/.test(c.textContent)),
    null,
    { timeout: 10_000 }
  )
  ok('Dan undeafened: audio flowing again')

  if (SHOTS) {
    await dan.mouse.move(5, 300)
    await dan.waitForTimeout(400)
    await dan.screenshot({ path: `${SHOTS}/route.png` })
  }

  // Someone in the middle leaves: the rest close the gap.
  await extra[1].click('button[aria-label="Disconnect"]')
  await expectSeats(dan, 5, 'Dan after Finn left')
  ok('Finn left, five remain')

  // The experimental low-latency engine, between the two people who turn it on.
  const eve = extra[0]
  const enableLL = async p => {
    await p.click('button[aria-label="Voice Settings"]')
    await p.click('button[role="tab"]:has-text("Low Latency")')
    await p.click('text=Low-Latency Engine (Experimental)')
    await p.click('button[aria-label="Voice Settings"]')
  }
  const cardFor = (page, name) =>
    page.$$eval(
      '.seat',
      (els, name) => els.find(e => e.querySelector('.name')?.textContent.trim() === name)?.querySelector('.route')?.innerText ?? '',
      name
    )
  const webrtcCard = await cardFor(dan, 'Eve')
  await enableLL(dan)
  await enableLL(eve)
  await dan.waitForFunction(
    () => {
      const seat = [...document.querySelectorAll('.seat')].find(e => e.querySelector('.name')?.textContent.trim() === 'Eve')
      return /low-latency engine/i.test(seat?.querySelector('.route')?.textContent ?? '')
    },
    null,
    { timeout: 20_000 }
  ).catch(() => {
    throw new Error('Dan and Eve both turned on the low-latency engine but it never took over')
  })
  // Still hearing her, now over the new engine.
  await extra[0].click('button[aria-label="Mute"]')
  await extra[0].click('button[aria-label="Unmute"]')
  await dan.waitForFunction(
    () => [...document.querySelectorAll('.seat.speaking')].some(e => e.querySelector('.name')?.textContent.trim() === 'Eve'),
    null,
    { timeout: 15_000 }
  ).catch(() => {
    throw new Error('low-latency engine up, but Dan never heard Eve')
  })
  await dan.waitForTimeout(4000)
  const one = s => s.replace(/\s*\n\s*/g, ' | ')
  ok('Eve on WebRTC audio:     ' + one(webrtcCard))
  ok('Eve on low-latency engine: ' + one(await cardFor(dan, 'Eve')))
  // Everyone else stays on WebRTC audio, and still works.
  if (!/webrtc audio/i.test(await cardFor(dan, 'Bob'))) throw new Error('Bob should still be on WebRTC audio')
  ok('the others stay on WebRTC audio')
  if (SHOTS) {
    await dan.mouse.move(5, 300)
    await dan.waitForTimeout(500)
    await dan.screenshot({ path: `${SHOTS}/ll-route.png` })
    await dan.click('button[aria-label="Voice Settings"]')
    await dan.click('button[role="tab"]:has-text("Low Latency")')
    await dan.waitForTimeout(300)
    await dan.screenshot({ path: `${SHOTS}/ll-settings.png` })
    await dan.click('button[aria-label="Voice Settings"]')
  }

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
