import { describe, expect, it } from 'vitest'
import { createWakeLock } from '../src/lib/wakeLock'

/** A browser's wake lock, with a hand on when requests come through and when the system drops the lock. */
function fake(opts: { visible?: boolean; refuse?: boolean; hasApi?: boolean } = {}) {
  const sentinels: { released: boolean; listeners: (() => void)[]; drop(): void }[] = []
  const pending: (() => void)[] = []
  const doc = {
    visibilityState: (opts.visible === false ? 'hidden' : 'visible') as DocumentVisibilityState,
    listeners: new Set<() => void>(),
    addEventListener(_: string, fn: () => void) {
      this.listeners.add(fn)
    },
    removeEventListener(_: string, fn: () => void) {
      this.listeners.delete(fn)
    },
    show() {
      this.visibilityState = 'visible'
      for (const fn of [...this.listeners]) fn()
    }
  }
  const nav = {
    wakeLock:
      opts.hasApi === false
        ? undefined
        : {
            request: (_: 'screen') =>
              new Promise<never>((resolve, reject) => {
                pending.push(() => {
                  if (opts.refuse) return reject(new DOMException('no', 'NotAllowedError'))
                  const s = {
                    released: false,
                    listeners: [] as (() => void)[],
                    release: async () => void (s.released = true),
                    addEventListener: (_: 'release', fn: () => void) => void s.listeners.push(fn),
                    drop: () => {
                      s.released = true
                      s.listeners.forEach(fn => fn())
                    }
                  }
                  sentinels.push(s)
                  resolve(s as never)
                })
              })
          }
  }
  const settle = async () => {
    while (pending.length) pending.shift()!()
    await new Promise(r => setTimeout(r, 0))
  }
  return { doc: doc as unknown as Document, nav, sentinels, settle, show: () => doc.show(), requests: () => pending.length }
}

describe('wake lock', () => {
  it('holds a lock while wanted and lets go when not', async () => {
    const f = fake()
    const w = createWakeLock({ nav: f.nav, doc: f.doc })
    w.set(true)
    await f.settle()
    expect(f.sentinels).toHaveLength(1)
    expect(f.sentinels[0].released).toBe(false)
    w.set(false)
    expect(f.sentinels[0].released).toBe(true)
  })

  it('asks again when the system drops it and the page comes back', async () => {
    const f = fake()
    const w = createWakeLock({ nav: f.nav, doc: f.doc })
    w.set(true)
    await f.settle()
    f.sentinels[0].drop()
    f.show()
    await f.settle()
    expect(f.sentinels).toHaveLength(2)
    expect(f.sentinels[1].released).toBe(false)
    w.set(false)
  })

  it("doesn't ask twice when the page is shown with a lock held", async () => {
    const f = fake()
    const w = createWakeLock({ nav: f.nav, doc: f.doc })
    w.set(true)
    await f.settle()
    f.show()
    await f.settle()
    expect(f.sentinels).toHaveLength(1)
  })

  it('waits for the page to be shown, if it starts hidden', async () => {
    const f = fake({ visible: false })
    const w = createWakeLock({ nav: f.nav, doc: f.doc })
    w.set(true)
    await f.settle()
    expect(f.sentinels).toHaveLength(0)
    f.show()
    await f.settle()
    expect(f.sentinels).toHaveLength(1)
  })

  it('lets go of a lock that came through after it was no longer wanted', async () => {
    const f = fake()
    const w = createWakeLock({ nav: f.nav, doc: f.doc })
    w.set(true)
    w.set(false)
    await f.settle()
    expect(f.sentinels).toHaveLength(1)
    expect(f.sentinels[0].released).toBe(true)
  })

  it('ends up holding one if it was switched off and on while asking', async () => {
    const f = fake()
    const w = createWakeLock({ nav: f.nav, doc: f.doc })
    w.set(true)
    w.set(false)
    w.set(true)
    await f.settle()
    await f.settle()
    const live = f.sentinels.filter(s => !s.released)
    expect(live).toHaveLength(1)
    w.set(false)
    expect(f.sentinels.every(s => s.released)).toBe(true)
  })

  it('does nothing, without a word, when refused or unsupported', async () => {
    const refused = fake({ refuse: true })
    const a = createWakeLock({ nav: refused.nav, doc: refused.doc })
    a.set(true)
    await refused.settle()
    refused.show()
    await refused.settle()
    expect(refused.sentinels).toHaveLength(0)
    a.set(false)

    const none = fake({ hasApi: false })
    const b = createWakeLock({ nav: none.nav, doc: none.doc })
    expect(() => {
      b.set(true)
      b.set(false)
    }).not.toThrow()
  })
})
