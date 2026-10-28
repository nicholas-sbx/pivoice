/**
 * Where to get the app. Each release (release-native.yml) has one file per
 * platform; the site links straight to them, for the newest app it knows of
 * (native/VERSION when it was built, whose release its deploy waited for).
 */

export type AppOS = 'windows' | 'linux' | 'darwin'

export interface AppDownload {
  /** As Go names it (the app reports runtime.GOOS). */
  os: AppOS
  label: string
  /** The file's name in that version's release: pivoice-<version>-<platform>. */
  file(version: string): string
}

const named = (platform: string) => (version: string) => `pivoice-${version}-${platform}`

/** What each release has. Keep in step with the build matrix in release-native.yml. */
export const APP_DOWNLOADS: AppDownload[] = [
  { os: 'windows', label: 'Windows', file: named('windows-amd64.exe') },
  { os: 'linux', label: 'Linux', file: named('linux-amd64.tar.gz') }
  // macOS releases are switched off for now; when they're back:
  // { os: 'darwin', label: 'macOS', file: named('macos.tar.gz') }
]

const RELEASES = 'https://github.com/nicholas-sbx/pivoice/releases'

/**
 * The release's page (VITE_NATIVE_DOWNLOAD_URL if set, `{version}` filled
 * in), or one of its files when `file` is given and the downloads are on
 * GitHub (or the template has a `{file}` for it).
 */
export function downloadUrl(version: string, file?: string): string {
  const template = import.meta.env.VITE_NATIVE_DOWNLOAD_URL?.trim()
  if (!template) return file ? `${RELEASES}/download/native-v${version}/${file}` : `${RELEASES}/tag/native-v${version}`
  if (file && !template.includes('{file}')) return template.replaceAll('{version}', version)
  return template.replaceAll('{version}', version).replaceAll('{file}', file ?? '')
}

/** The visitor's own platform, as far as the browser says, if there's an app for it. */
export function visitorOS(): AppOS | null {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string; mobile?: boolean } }
  if (nav.userAgentData?.mobile) return null
  const p = (nav.userAgentData?.platform || nav.platform || nav.userAgent).toLowerCase()
  if (/android|iphone|ipad/.test(nav.userAgent.toLowerCase())) return null
  if (p.includes('win')) return 'windows'
  if (p.includes('linux')) return 'linux'
  if (p.includes('mac')) return 'darwin'
  return null
}
