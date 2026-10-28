import { describe, expect, it } from 'vitest'
import { compareVersions, judge } from '../src/native/protocol'

describe('app versions', () => {
  it('compares by number, part by part', () => {
    expect(compareVersions('0.10.0', '0.9.1')).toBe(1)
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('v1.2.3', '1.2.4')).toBe(-1)
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
  })

  it('sends people with an old app to download the new one', () => {
    expect(judge({ version: '0.1.0', protocol: 1 }, '0.2.0', 2)).toEqual({ ok: false, action: 'download', latest: '0.2.0' })
  })

  it('has people restart when the app is newer than the page', () => {
    // The page is cached, or the site's release hasn't gone out yet.
    expect(judge({ version: '0.3.0', protocol: 3 }, '0.2.0', 2)).toEqual({ ok: false, action: 'restart' })
  })

  it('carries on with the same protocol, mentioning a newer app if there is one', () => {
    expect(judge({ version: '0.2.0', protocol: 2 }, '0.2.1', 2)).toEqual({ ok: true, newer: '0.2.1' })
    expect(judge({ version: '0.2.1', protocol: 2 }, '0.2.1', 2)).toEqual({ ok: true, newer: null })
    // An app released before the site knows about it is fine.
    expect(judge({ version: '0.2.2', protocol: 2 }, '0.2.1', 2)).toEqual({ ok: true, newer: null })
  })
})
