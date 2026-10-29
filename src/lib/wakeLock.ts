/**
 * Keeps the screen from sleeping while there's a call: a phone left on a
 * table on speaker would otherwise lock, and the browser stops the mic and
 * the page's audio with it.
 *
 * Quiet by design: no Wake Lock API, a refusal (low battery, a policy), or
 * anything else going wrong just means the screen sleeps as it always did.
 * The browser drops the lock whenever the page is hidden, so it's asked for
 * again when the page is shown.
 */

interface Sentinel {
  release(): Promise<void>
  addEventListener(type: 'release', listener: () => void): void
}

interface Env {
  nav: { wakeLock?: { request(type: 'screen'): Promise<Sentinel> } }
  doc: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
}

export interface WakeLock {
  /** Whether the screen should stay awake right now. */
  set(on: boolean): void
}

export function createWakeLock(env: Env = { nav: navigator, doc: document }): WakeLock {
  let wanted = false
  let held: Sentinel | null = null
  /** Bumped on every change, so a request that lands late can tell it was overtaken. */
  let ask = 0
  let asking = false

  async function acquire() {
    if (!wanted || held || asking || env.doc.visibilityState !== 'visible' || !env.nav.wakeLock) return
    const mine = ++ask
    asking = true
    let overtaken = false
    try {
      const sentinel = await env.nav.wakeLock.request('screen')
      if (mine !== ask) {
        // Switched off (and maybe on again) while it was coming through.
        overtaken = true
        void sentinel.release().catch(() => {})
      } else {
        held = sentinel
        sentinel.addEventListener('release', () => {
          if (held === sentinel) held = null
        })
      }
    } catch {
      /* refused or unsupported: the screen just sleeps as usual */
    } finally {
      asking = false
    }
    if (overtaken) void acquire()
  }

  function release() {
    ask++
    const sentinel = held
    held = null
    void sentinel?.release().catch(() => {})
  }

  function onVisible() {
    if (env.doc.visibilityState === 'visible') void acquire()
  }

  return {
    set(on) {
      if (on === wanted) return
      wanted = on
      if (on) {
        env.doc.addEventListener('visibilitychange', onVisible)
        void acquire()
      } else {
        env.doc.removeEventListener('visibilitychange', onVisible)
        release()
      }
    }
  }
}
