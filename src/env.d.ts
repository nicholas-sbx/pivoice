/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Canonical public URL of the app, used for the invite link. */
  readonly VITE_PUBLIC_URL?: string
  /** Optional TURN relay baked into the build, for when STUN alone can't get through. */
  readonly VITE_TURN_URLS?: string
  readonly VITE_TURN_USERNAME?: string
  readonly VITE_TURN_CREDENTIAL?: string
  /** Where to get the app. `{version}` is filled in; defaults to the repo's GitHub release. */
  readonly VITE_NATIVE_DOWNLOAD_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** The app's version from package.json, filled in at build time (see vite.config.ts). */
declare const __APP_VERSION__: string
/** The newest app's version, from native/VERSION at build time. */
declare const __NATIVE_VERSION__: string

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

/** Document Picture-in-Picture (Chrome and Edge 116+, recent Firefox): an always-on-top window with a page of our own in it. Not in lib.dom yet. */
interface DocumentPictureInPicture extends EventTarget {
  requestWindow(options?: { width?: number; height?: number; disallowReturnToOpener?: boolean; preferInitialWindowPlacement?: boolean }): Promise<Window>
  readonly window: Window | null
}
interface Window {
  readonly documentPictureInPicture?: DocumentPictureInPicture
}
