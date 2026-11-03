import type { DownloadPolicy } from './config'

/**
 * Whether the captions model (41 MB) may be downloaded without asking.
 *
 * The Network Information API says what kind of connection this is, where
 * there is one: Chrome on Android (`type`: cellular, wifi, ...), and
 * `saveData` (the person asked for less data) in Chromium generally.
 * Desktop browsers don't say, and Firefox and Safari have none of it, so
 * an unknown connection on a phone or tablet is taken for mobile data (ask
 * first) and on a computer for not (go ahead).
 */

export interface ConnectionLike {
  type?: string
  saveData?: boolean
}

export type Metered = 'yes' | 'no' | 'unknown'

/** Whether this connection costs by the byte, as far as the browser says. */
export function metered(conn: ConnectionLike | undefined): Metered {
  if (!conn) return 'unknown'
  if (conn.saveData) return 'yes'
  switch (conn.type) {
    case 'cellular':
    case 'bluetooth':
      // Bluetooth: most likely tethered to a phone.
      return 'yes'
    case 'wifi':
    case 'ethernet':
    case 'wimax':
      return 'no'
    default:
      return 'unknown'
  }
}

/** Download now, or ask first. */
export function downloadDecision(policy: DownloadPolicy, m: Metered, phone: boolean): 'download' | 'ask' {
  if (policy === 'always') return 'download'
  if (policy === 'ask') return 'ask'
  if (m === 'yes') return 'ask'
  if (m === 'no') return 'download'
  return phone ? 'ask' : 'download'
}

/** The browser's connection, if it says. */
export function currentConnection(): (ConnectionLike & EventTarget) | undefined {
  return (navigator as Navigator & { connection?: ConnectionLike & EventTarget }).connection
}
