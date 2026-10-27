/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Canonical public URL of the app, used for the invite link. */
  readonly VITE_PUBLIC_URL?: string
  /** Optional self-hosted PeerJS server. Defaults to the PeerJS cloud broker. */
  readonly VITE_PEER_HOST?: string
  readonly VITE_PEER_PORT?: string
  readonly VITE_PEER_PATH?: string
  readonly VITE_PEER_SECURE?: string
  readonly VITE_PEER_KEY?: string
  /** Optional TURN relay baked into the build, for when STUN alone can't get through. */
  readonly VITE_TURN_URLS?: string
  readonly VITE_TURN_USERNAME?: string
  readonly VITE_TURN_CREDENTIAL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** The app's version from package.json, filled in at build time (see vite.config.ts). */
declare const __APP_VERSION__: string

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}
