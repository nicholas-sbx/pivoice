import { reactive } from 'vue'
import { NATIVE_PROTOCOL, judge, type AppInfo, type FromApp, type ToApp, type Verdict } from './protocol'

/**
 * The page's end of the bridge to the app (native/internal/bridge).
 *
 * Two ways the page can find itself talking to the app:
 *
 *  - in the app's own window, which puts `window.__pivoiceNative` there
 *    before any of our code runs (and only on our own origin);
 *  - in an ordinary browser that the app opened (`--browser`, and the
 *    end-to-end tests), with the app's address and key in the #fragment:
 *    `#native=PORT.TOKEN`, maybe after a room code. That's taken out of
 *    the address the moment we've read it, and kept for this tab only
 *    (sessionStorage) so a reload finds the app again.
 *
 * Anywhere else the page is just the website, doing its own audio.
 */

declare global {
  interface Window {
    __pivoiceNative?: { token: string; send(msg: string): void; onmessage: ((msg: unknown) => void) | null }
  }
}

export type NativeState = 'off' | 'connecting' | 'ready' | 'mismatch' | 'lost'

/** For the UI. `off` means we're the plain website. */
export const native = reactive({
  state: 'off' as NativeState,
  app: null as AppInfo | null,
  verdict: null as Verdict | null
})

const STORE = 'pv.native'
const HELLO_TIMEOUT_MS = 5000

interface Transport {
  send(msg: string): void
  close(): void
}

type Where = { kind: 'window' } | { kind: 'socket'; port: number; token: string }

/**
 * Where the app is, if anywhere. Runs once, when this module loads (before
 * the UI reads the address), so the app's key never sits in the address bar.
 */
function locate(): Where | null {
  if (typeof window === 'undefined') return null
  if (window.__pivoiceNative && typeof window.__pivoiceNative.send === 'function') return { kind: 'window' }
  const parts = location.hash.replace(/^#/, '').split('&').filter(Boolean)
  const i = parts.findIndex(p => p.startsWith('native='))
  if (i >= 0) {
    const m = /^native=(\d{1,5})\.([A-Za-z0-9_-]{43})$/.exec(parts[i])
    parts.splice(i, 1)
    history.replaceState(null, '', location.pathname + location.search + (parts.length ? '#' + parts.join('&') : ''))
    if (m) {
      const where = { kind: 'socket' as const, port: Number(m[1]), token: m[2] }
      try {
        sessionStorage.setItem(STORE, JSON.stringify(where))
      } catch {
        /* storage blocked: a reload loses the app, nothing worse */
      }
      return where
    }
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE) ?? 'null') as Partial<Extract<Where, { kind: 'socket' }>> | null
    if (saved && typeof saved.port === 'number' && typeof saved.token === 'string') return { kind: 'socket', port: saved.port, token: saved.token }
  } catch {
    /* nothing saved */
  }
  return null
}

const where = locate()

/** Whether this page is the app's UI. Known from the moment the page loads. */
export const isNative = where !== null

export class NativeBridge {
  private transport: Transport | null = null
  private listeners = new Set<(m: FromApp) => void>()

  constructor(
    private site: string,
    private latest: string
  ) {}

  /** Say hello and see whether we can work together. */
  connect(): Promise<boolean> {
    native.state = 'connecting'
    return new Promise(resolve => {
      let settled = false
      const done = (ok: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(ok)
      }
      const timer = setTimeout(() => {
        native.state = 'lost'
        done(false)
      }, HELLO_TIMEOUT_MS)
      const onHello = (m: FromApp) => {
        if (m.t !== 'hello') return
        native.app = { version: m.version, protocol: m.protocol, os: m.os, arch: m.arch }
        native.verdict = judge(m, this.latest)
        native.state = native.verdict.ok ? 'ready' : 'mismatch'
        done(native.verdict.ok)
      }
      this.listeners.add(onHello)
      this.open(token => this.send({ t: 'hello', token, site: this.site, protocol: NATIVE_PROTOCOL }), () => {
        native.state = 'lost'
        done(false)
      })
    })
  }

  private open(hello: (token: string) => void, lost: () => void) {
    if (where?.kind === 'window') {
      const api = window.__pivoiceNative!
      api.onmessage = msg => this.dispatch(msg)
      this.transport = { send: s => api.send(s), close: () => (api.onmessage = null) }
      hello(api.token)
      return
    }
    if (where?.kind !== 'socket') return lost()
    const ws = new WebSocket(`ws://127.0.0.1:${where.port}/bridge`)
    this.transport = { send: s => ws.readyState === WebSocket.OPEN && ws.send(s), close: () => ws.close() }
    ws.onopen = () => hello(where.token)
    ws.onmessage = e => {
      try {
        this.dispatch(JSON.parse(String(e.data)))
      } catch {
        /* not ours */
      }
    }
    // The app quit (or was never there).
    ws.onclose = () => lost()
  }

  private dispatch(msg: unknown) {
    if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') return
    for (const l of [...this.listeners]) l(msg as FromApp)
  }

  send(msg: ToApp) {
    this.transport?.send(JSON.stringify(msg))
  }

  on(listener: (m: FromApp) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Ask for something and wait for the answer of that type (that `match` accepts, if given). */
  request<T extends FromApp['t']>(
    msg: ToApp,
    type: T,
    timeoutMs = 2000,
    match: (m: Extract<FromApp, { t: T }>) => boolean = () => true
  ): Promise<Extract<FromApp, { t: T }> | null> {
    return new Promise(resolve => {
      const off = this.on(m => {
        if (m.t !== type || !match(m as Extract<FromApp, { t: T }>)) return
        off()
        clearTimeout(timer)
        resolve(m as Extract<FromApp, { t: T }>)
      })
      const timer = setTimeout(() => {
        off()
        resolve(null)
      }, timeoutMs)
      this.send(msg)
    })
  }
}

/** Use the website's own audio from now on in this tab (after the app's gone away). */
export function forgetApp() {
  try {
    sessionStorage.removeItem(STORE)
  } catch {
    /* fine */
  }
  location.reload()
}
