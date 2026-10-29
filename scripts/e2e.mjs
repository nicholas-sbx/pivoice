// End-to-end: real Chromium tabs with fake microphones, in rooms on the
// Worker's Durable Objects running locally.
//
//   npm run dev           # terminal 1: the app and the Worker
//   npm run e2e           # terminal 2
//
// Checks that people can make and join a room, see each other at the table,
// hear each other (the fake mic beeps, which lights up the speaking ring on
// everyone else's screen), and that the call survives whoever made the room
// leaving.
import { mkdirSync, readFileSync } from 'node:fs'
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

// Fully there means no inline opacity at all (seats at rest are left untouched so they stay crisp).
const seats = page => page.$$eval('.seat', els => els.filter(e => (e.style.opacity === '' ? 1 : Number(e.style.opacity)) > 0.5).length)
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

  // Mic test, each path, while alone: it deafens her, plays her back, says how long it took.
  await alice.click('button[aria-label="Voice Settings"]')
  // Popups on whole pixels, or their text is drawn blurry (the controls are centred, at any window width).
  for (const w of [1281, 1440]) {
    await alice.setViewportSize({ width: w, height: 900 })
    await alice.waitForTimeout(300)
    const off = await alice.$$eval('.pill, .panel, .tip', els =>
      els
        .map(e => ({ e, r: e.getBoundingClientRect() }))
        .filter(({ r }) => Math.abs(r.left - Math.round(r.left)) > 0.01 || Math.abs(r.top - Math.round(r.top)) > 0.01)
        .map(({ e, r }) => `${e.className} at ${r.left.toFixed(2)}, ${r.top.toFixed(2)}`)
    )
    if (off.length) throw new Error(`blurry at ${w}px wide: ${off.join('; ')}`)
  }
  ok('the call controls, the settings panel and the tooltips sit on whole pixels')
  for (const label of ['Raw', 'WebRTC audio', 'Low latency']) {
    await alice.click(`.seg button:has-text("${label}")`)
    if (!(await alice.$('.test-btn.stop'))) await alice.click('.test-btn')
    await alice.waitForFunction(() => /\d+ ms/.test(document.querySelector('.test-out strong')?.textContent ?? ''), null, { timeout: 15_000 }).catch(() => {
      throw new Error(`mic test (${label}) never reported a latency`)
    })
    if (!(await alice.$('button[aria-label="Undeafen"]'))) throw new Error('mic test should deafen you while it runs')
    ok(`mic test, ${label}: ` + (await alice.$eval('.test-out', e => e.innerText.replace(/\s*\n\s*/g, ' | '))))
  }
  await alice.click('.test-btn')
  await alice.click('button[aria-label="Voice Settings"]')
  if (!(await alice.$('button[aria-label="Deafen"]'))) throw new Error('stopping the mic test should undeafen you')
  ok('mic test stopped, undeafened again')

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

  // The person who made the room leaves: it's nobody's in particular, so the call carries on.
  await alice.click('button[aria-label="Disconnect"]')
  await alice.waitForSelector('button:has-text("Create a Room")')
  await expectSeats(bob, 2, 'Bob after Alice left')
  await expectSeats(cara, 2, 'Cara after Alice left')
  ok('Alice (who made the room) left; Bob and Cara still connected')

  const dan = await open('Dan', code)
  for (const [p, n] of [
    [bob, 'Bob'],
    [cara, 'Cara'],
    [dan, 'Dan']
  ]) {
    await expectSeats(p, 3, n + ' after Dan joined')
  }
  await expectHearsSomeone(dan, 'Dan')
  ok('Dan joined the room after Alice left and hears people')

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

  // The table popped out into its own always-on-top window (Document Picture-in-Picture).
  if (!(await dan.evaluate(() => 'documentPictureInPicture' in window))) {
    console.log('- pop-out: this Chromium has no Document Picture-in-Picture, skipped')
  } else {
    const [pip] = await Promise.all([dan.context().waitForEvent('page', { timeout: 10_000 }), dan.click('button[aria-label="Pop out table"]')])
    pip.on('pageerror', e => console.error('[pop-out] page error:', e.message))
    await pip.waitForSelector('.seat', { timeout: 10_000 })
    await pip.waitForFunction(() => [...document.querySelectorAll('.seat')].filter(e => e.style.opacity === '').length === 6, null, { timeout: 10_000 }).catch(async () => {
      throw new Error(`pop-out: expected six seats at rest, saw ${await pip.$$eval('.seat', e => e.length)}`)
    })
    if (!(await dan.$('button[aria-label="Close pop-out table"][aria-pressed="true"]'))) throw new Error('pop-out: the button should show it is open')
    // The same table: you at the bottom, everyone else at their seats, names and all.
    const names = await pip.$$eval('.seat .name', els => els.map(e => e.textContent.trim()).sort())
    if (names.join() !== ['Bob', 'Cara', 'Dan', 'Eve', 'Finn', 'Gus'].join()) throw new Error('pop-out: wrong people at the table: ' + names)
    const lowest = await pip.$$eval('.seat', els => els.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0].classList.contains('self'))
    if (!lowest) throw new Error('pop-out: you should be at the bottom')
    // Everyone fits at the sizes it's meant for, and nothing runs past the edge.
    for (const size of [240, 320, 500]) {
      await pip.setViewportSize({ width: size, height: size })
      await pip.waitForTimeout(300)
      const out = await pip.evaluate(() => {
        const stage = document.querySelector('.stage').getBoundingClientRect()
        const bad = [...document.querySelectorAll('.seat .ring, .seat .tag')]
          .filter(e => {
            const r = e.getBoundingClientRect()
            return r.left < -0.5 || r.right > innerWidth + 0.5 || r.top < -0.5 || r.bottom > stage.bottom + 0.5
          })
          .map(e => e.className)
        return { bad, wide: document.documentElement.scrollWidth > innerWidth, tall: document.documentElement.scrollHeight > innerHeight }
      })
      if (out.bad.length || out.wide || out.tall) throw new Error(`pop-out at ${size}px: ${JSON.stringify(out)}`)
    }
    await pip.setViewportSize({ width: 320, height: 320 })
    await pip.waitForTimeout(300)
    if (process.env.PIP_SHOT) await pip.screenshot({ path: process.env.PIP_SHOT })
    ok('pop-out: the table in its own window at 240, 320 and 500 px, six seats, you at the bottom')

    // Its buttons and shortcuts are the call's.
    await pip.click('button[aria-label="Mute"]')
    await dan.waitForSelector('button[aria-label="Unmute"]', { timeout: 5_000 })
    await pip.waitForSelector('button[aria-label="Unmute"]', { timeout: 5_000 })
    await pip.click('button[aria-label="Unmute"]')
    await dan.waitForSelector('button[aria-label="Mute"]', { timeout: 5_000 })
    await pip.keyboard.press('Control+Shift+D')
    await dan.waitForSelector('button[aria-label="Undeafen"]', { timeout: 5_000 }).catch(() => {
      throw new Error('pop-out: Ctrl+Shift+D in the pop-out did nothing')
    })
    await pip.click('button[aria-label="Undeafen"]')
    await dan.waitForSelector('button[aria-label="Deafen"]', { timeout: 5_000 })
    await pip.click('button[aria-label="Spatial Audio: Off"]')
    await dan.waitForSelector('button[aria-label="Spatial Audio: HRTF"]', { timeout: 5_000 }).catch(() => {
      throw new Error("pop-out: its spatial audio button didn't turn it on")
    })
    await pip.waitForSelector('button[aria-label="Spatial Audio: HRTF"][aria-pressed="true"]', { timeout: 5_000 })
    await pip.click('button[aria-label="Spatial Audio: HRTF"]')
    await dan.waitForSelector('button[aria-label="Spatial Audio: Off"]', { timeout: 5_000 })
    ok('pop-out: mute, deafen and spatial audio from its buttons, and Ctrl+Shift+D, shown on both')

    // Someone in the middle of the pop-out sees it when they speak: a ring in the pop-out too.
    await pip.waitForSelector('.seat.speaking:not(.self)', { timeout: 15_000 }).catch(() => {
      throw new Error('pop-out: never saw anyone speaking')
    })

    // The button closes it; closing it from its own window puts the button back.
    await dan.click('button[aria-label="Close pop-out table"]')
    await pip.waitForEvent('close', { timeout: 5_000 }).catch(() => {})
    if (!pip.isClosed()) throw new Error('pop-out: the button should close it')
    await dan.waitForSelector('button[aria-label="Pop out table"][aria-pressed="false"]', { timeout: 5_000 })
    const [again] = await Promise.all([dan.context().waitForEvent('page', { timeout: 10_000 }), dan.click('button[aria-label="Pop out table"]')])
    await again.waitForSelector('.seat', { timeout: 10_000 })
    await again.evaluate(() => window.close())
    await dan.waitForSelector('button[aria-label="Pop out table"][aria-pressed="false"]', { timeout: 5_000 }).catch(() => {
      throw new Error('pop-out: closing its window should reset the button')
    })
    ok('pop-out: opens and closes from the button, and from its own window')
  }

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

  // In a browser the low-latency engine is off by default (the app has it on),
  // so everyone's on WebRTC audio; then they all turn it on, Eve turns it back
  // off, and only the pairs with her go back to WebRTC audio.
  const eve = extra[0]
  const toggleLL = async p => {
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
  const engineOf = (page, name, re) =>
    page.waitForFunction(
      ([name, src]) => {
        const seat = [...document.querySelectorAll('.seat')].find(e => e.querySelector('.name')?.textContent.trim() === name)
        return new RegExp(src, 'i').test(seat?.querySelector('.route')?.textContent ?? '')
      },
      [name, re.source],
      { timeout: 20_000 }
    )
  await engineOf(dan, 'Eve', /webrtc audio/).catch(() => {
    throw new Error('in a browser, the low-latency engine should be off by default')
  })
  ok('low-latency engine off by default in a browser')
  for (const p of [bob, cara, dan, eve, extra[2]]) await toggleLL(p)
  await engineOf(dan, 'Eve', /low-latency engine/).catch(() => {
    throw new Error('everyone turned the low-latency engine on but it never took over')
  })
  await dan.waitForTimeout(3000)
  const llCard = await cardFor(dan, 'Eve')
  if (!/pcm/i.test(llCard)) throw new Error('the low-latency engine should send raw PCM by default: ' + llCard)
  await toggleLL(eve)
  await engineOf(dan, 'Eve', /webrtc audio/).catch(() => {
    throw new Error('Eve turned the low-latency engine off but Dan still has her on it')
  })
  // Still hearing her, now over WebRTC audio.
  await eve.click('button[aria-label="Mute"]')
  await eve.click('button[aria-label="Unmute"]')
  await dan.waitForFunction(
    () => [...document.querySelectorAll('.seat.speaking')].some(e => e.querySelector('.name')?.textContent.trim() === 'Eve'),
    null,
    { timeout: 15_000 }
  ).catch(() => {
    throw new Error('Eve back on WebRTC audio, but Dan never heard her')
  })
  await dan.waitForTimeout(4000)
  const one = s => s.replace(/\s*\n\s*/g, ' | ')
  ok('Eve on low-latency engine: ' + one(llCard))
  ok('Eve on WebRTC audio:       ' + one(await cardFor(dan, 'Eve')))
  // Everyone else stays on the engine, and still works.
  if (!/low-latency engine/i.test(await cardFor(dan, 'Bob'))) throw new Error('Bob should still be on the low-latency engine')
  ok('the others stay on the low-latency engine')
  await toggleLL(eve)
  await engineOf(dan, 'Eve', /low-latency engine/).catch(() => {
    throw new Error('Eve turned the low-latency engine back on but it never took over')
  })
  ok('Eve back on the low-latency engine')
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

  // A setting that needs a fresh connection reconnects on the spot: Dan stays in the room, as himself.
  const before = await seats(dan)
  await dan.click('button[aria-label="Voice Settings"]')
  await dan.click('button[role="tab"]:has-text("Low Latency")')
  await dan.click('button:has-text("Browser default")')
  await dan.click('button[aria-label="Voice Settings"]')
  await dan.waitForSelector('.status:has-text("Reconnecting")', { timeout: 5_000 }).catch(() => {})
  await expectSeats(dan, before, 'Dan after reconnecting to apply a setting')
  await expectHearsSomeone(dan, 'Dan after reconnecting')
  await expectSeats(bob, before, 'Bob while Dan reconnected')
  ok('changing the output buffer reconnected Dan on the spot; same seat, still hearing everyone')

  // On a phone: a list of tiles while spatial audio is off, the table when it's on, a tap for someone's menu.
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      permissions: ['microphone'],
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    })
    const phone = await ctx.newPage()
    phone.on('pageerror', e => console.error('[Pia] page error:', e.message))
    // Everything on screen, measured (the page itself can't get wider: overflow is clipped, so a cut-off card wouldn't show there).
    const offScreen = sel =>
      phone.$$eval(sel, els =>
        els
          .filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')
          .filter(e => {
            const r = e.getBoundingClientRect()
            return r.left < -0.5 || r.right > innerWidth + 0.5
          })
          .map(e => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`)
      )
    await phone.goto(APP + '#' + code)
    await phone.waitForSelector('.card')
    const cutHome = await offScreen('.card, .card *')
    if (cutHome.length) throw new Error('phone: the start screen runs off the screen: ' + cutHome.slice(0, 5).join(', '))
    if (await phone.$('.get-app')) throw new Error('phone: offered the desktop app on a phone')
    await phone.fill('input[autocomplete="nickname"]', 'Pia')
    await phone.tap('button:has-text("Join Room")')
    await phone.waitForSelector('.pill', { timeout: 20_000 })
    pages.push({ name: 'Pia', page: phone, ctx })
    const n = before + 1
    await phone.waitForFunction(n => document.querySelectorAll('.tile').length === n, n, { timeout: 20_000 }).catch(async () => {
      throw new Error(`phone: expected ${n} tiles, saw ${await phone.$$eval('.tile', e => e.length)}`)
    })
    if (await phone.$('.table')) throw new Error('phone: the table showed with spatial audio off')
    if (await phone.$('button[aria-label="Pop out table"]')) throw new Error('phone: offered a pop-out window on a phone')
    const wide = await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth)
    if (wide) throw new Error('phone: the page is wider than the screen')
    const cutRoom = await offScreen('.bar, .bar > *, .pill, .tile, .tile .tag')
    if (cutRoom.length) throw new Error('phone: the room runs off the screen: ' + cutRoom.slice(0, 5).join(', '))
    await expectHearsSomeone(phone, 'Pia (phone)')
    await phone.tap('.tile:not(.self)')
    await phone.waitForSelector('.menu', { timeout: 5_000 }).catch(() => {
      throw new Error("phone: tapping someone didn't open their menu")
    })
    await phone.tap('.bar')
    await phone.tap('button[aria-label^="Spatial Audio"]')
    await phone.waitForSelector('.table', { timeout: 5_000 }).catch(() => {
      throw new Error('phone: spatial audio on but no table')
    })
    if (await phone.$('.tile')) throw new Error('phone: tiles still showing with spatial audio on')
    await phone.tap('button[aria-label="Voice Settings"]')
    const cutSheet = await offScreen('.panel')
    if (cutSheet.length) throw new Error('phone: the settings sheet runs off the screen')
    await phone.tap('button[aria-label="Voice Settings"]')
    ok(`phone: ${n} tiles with spatial audio off, the table with it on, a tap opens someone's menu`)
    if (SHOTS) {
      await phone.waitForTimeout(800)
      await phone.screenshot({ path: `${SHOTS}/phone-table.png` })
      await phone.tap('button[aria-label^="Spatial Audio"]')
      await phone.waitForTimeout(500)
      await phone.screenshot({ path: `${SHOTS}/phone.png` })
    }
  }

  // Hanging up from the pop-out leaves the call, and takes the pop-out with it.
  if (await extra[2].evaluate(() => 'documentPictureInPicture' in window)) {
    const gus = extra[2]
    const [gone] = await Promise.all([gus.context().waitForEvent('page', { timeout: 10_000 }), gus.click('button[aria-label="Pop out table"]')])
    await gone.waitForSelector('.seat', { timeout: 10_000 })
    await gone.click('button[aria-label="Disconnect"]')
    await gus.waitForSelector('button:has-text("Create a Room")')
    await gone.waitForEvent('close', { timeout: 5_000 }).catch(() => {})
    if (!gone.isClosed()) throw new Error('pop-out: should close when you leave the call')
    ok('pop-out: hanging up from it leaves the call and closes it')
  }

  // The app's overlay, with a stand-in for the app: what the page asks it for, and what the overlay's page draws from that.
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const app = await ctx.newPage()
    app.on('pageerror', e => console.error('[app] page error:', e.message))
    await app.addInitScript(version => {
      const sent = (window.__sent = [])
      const api = {
        token: 'x'.repeat(43),
        onmessage: null,
        send(s) {
          const m = JSON.parse(s)
          sent.push(m)
          const reply = r => setTimeout(() => api.onmessage?.(r), 5)
          if (m.t === 'hello') reply({ t: 'hello', version, protocol: m.protocol, os: 'linux', arch: 'amd64', noise: true, overlay: true })
          else if (m.t === 'audio' && m.on) reply({ t: 'audio', on: true, info: { input: 'Fake', output: 'Fake', api: 'Fake', inputLatencyMs: 3, outputLatencyMs: 3, block: 128 } })
          else if (m.t === 'devices') reply({ t: 'devices', devices: [] })
          else if (m.t === 'stats') reply({ t: 'stats', peers: {}, test: null, audio: null })
          else if (m.t === 'monitors')
            reply({
              t: 'monitors',
              placeable: true,
              onTop: true,
              monitors: [
                { id: 'Dell U2720Q', name: 'Dell U2720Q', width: 2560, height: 1400, primary: true, current: true },
                { id: 'LG 27GL850', name: 'LG 27GL850', width: 1920, height: 1040, primary: false, current: false }
              ]
            })
          else if (m.t === 'overlay' && m.op === 'show') reply({ t: 'overlay', on: true })
        }
      }
      Object.defineProperty(window, '__pivoiceNative', { value: api })
    }, readFileSync(new URL('../native/VERSION', import.meta.url), 'utf8').trim())
    await app.goto(APP)
    await app.fill('input[autocomplete="nickname"]', 'Ivy')
    await app.click('button:has-text("Create a Room")')
    await app.waitForSelector('.pill', { timeout: 20_000 })
    const asked = () => app.evaluate(() => window.__sent.filter(m => m.t === 'overlay' || m.t === 'monitors'))
    if ((await asked()).length) throw new Error('overlay: the page asked for it before it was switched on')
    if (await app.$('button[aria-label="Pop out table"]')) throw new Error('overlay: the app should get its overlay, not a pop-out')
    await app.click('button[aria-label="Show overlay"]')
    await app.waitForSelector('button[aria-label="Hide overlay"][aria-pressed="true"]', { timeout: 5_000 })
    const shown = (await asked()).find(m => m.op === 'show')
    if (!shown || shown.place.anchor !== 'top-right' || shown.place.size !== 260) throw new Error('overlay: not shown where it should be: ' + JSON.stringify(shown))
    // Its settings: the screens the app has, and every change moves it straight away.
    await app.click('button[aria-label="Voice Settings"]')
    await app.click('button[role="tab"]:has-text("Overlay")')
    await app.waitForSelector('option:has-text("LG 27GL850")', { state: 'attached', timeout: 5_000 })
    await app.selectOption('.overlay-settings select', 'LG 27GL850')
    await app.click('.overlay-settings button[aria-label="Bottom left"]')
    await app.waitForTimeout(200)
    const moved = (await asked()).filter(m => m.op === 'show').at(-1)
    if (moved.place.monitor !== 'LG 27GL850' || moved.place.anchor !== 'bottom-left') throw new Error('overlay: settings did not move it: ' + JSON.stringify(moved))
    const placing = (await asked()).filter(m => m.op === 'look').at(-1)
    if (!placing.look.placing) throw new Error('overlay: no outline while its settings are open')
    const cut = await app.evaluate(() => [...document.querySelectorAll('.overlay-settings *')].filter(e => e.getBoundingClientRect().right > innerWidth).length)
    if (cut) throw new Error('overlay: its settings run off the screen')
    if (SHOTS) await app.screenshot({ path: `${SHOTS}/overlay-settings.png` })
    await app.click('button[aria-label="Voice Settings"]')
    ok('overlay: shown with the call when switched on, on the screen and side its settings say')

    // The overlay's own page, fed as the app feeds it: the page's latest state and look, and the app's rings.
    const state = (await asked()).filter(m => m.op === 'state').at(-1).state
    if (state.selfId !== (await app.evaluate(() => document.querySelector('.seat.self')?.dataset.member))) throw new Error('overlay: the state is not about you')
    const people = ['Bob', 'Cara', 'Dan', 'Eve', 'Finn'].map((n, i) => ({ id: n, name: n, joinedAt: i, muted: n === 'Eve', deafened: false, ll: false, away: false }))
    const full = { ...state, members: [...state.members, ...people], seats: people.map((p, i) => ({ id: p.id, angle: (Math.PI * 2 * (i + 1)) / 6 })) }
    const ov = await ctx.newPage()
    ov.on('pageerror', e => console.error('[overlay] page error:', e.message))
    await ov.setViewportSize({ width: 260, height: 260 })
    await ov.addInitScript(() => {
      const api = { onmessage: null, ready: () => (window.__ready = true), _recv: m => api.onmessage?.(m) }
      Object.defineProperty(window, '__pivoiceOverlay', { value: api })
    })
    await ov.goto(APP + 'overlay.html')
    await ov.waitForFunction(() => window.__ready === true, null, { timeout: 10_000 })
    await ov.evaluate(([s, l]) => {
      window.__pivoiceOverlay._recv({ t: 'state', state: s })
      window.__pivoiceOverlay._recv({ t: 'look', look: l })
      window.__pivoiceOverlay._recv({ t: 'rings', speaking: ['Cara'], audible: ['Cara', 'Bob', ''] })
    }, [full, { ...placing.look, placing: false }])
    await ov.waitForFunction(() => document.querySelectorAll('.seat').length === 6, null, { timeout: 5_000 })
    const look = await ov.evaluate(() => {
      const bg = e => getComputedStyle(e).backgroundColor
      const at = id => document.querySelector(`.seat[data-member="${id}"]`).getBoundingClientRect()
      return {
        clear: [document.documentElement, document.body, document.querySelector('.overlay'), document.querySelector('.table')].map(bg),
        speaking: [...document.querySelectorAll('.seat.speaking')].map(e => e.dataset.member),
        selfAudible: document.querySelector('.seat.self').classList.contains('audible'),
        // Cara at 2π·2/6 (upper left on screen), Eve at 2π·4/6 (upper right), you at the bottom.
        cara: at('Cara').left < at('Eve').left && at('Cara').top < at(document.querySelector('.seat.self').dataset.member).top
      }
    })
    if (look.clear.some(c => c !== 'rgba(0, 0, 0, 0)')) throw new Error('overlay: its page has a background: ' + look.clear)
    if (look.speaking.join() !== 'Cara' || !look.selfAudible || !look.cara) throw new Error('overlay: wrong rings or seats: ' + JSON.stringify(look))
    if (SHOTS) await ov.screenshot({ path: `${SHOTS}/overlay.png`, omitBackground: true })
    ok("overlay: its page draws the call from what it's sent: see-through, seats where the page has them, the app's rings")

    await app.click('button[aria-label="Disconnect"]')
    await app.waitForSelector('button:has-text("Create a Room")')
    await app.waitForTimeout(200)
    if ((await asked()).at(-1).op !== 'hide') throw new Error('overlay: should be taken down when you leave the call')
    ok('overlay: taken down when you leave')
    await ctx.close()
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
