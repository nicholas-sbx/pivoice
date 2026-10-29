/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Shown on the start screen; each release bumps it in package.json.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }
// The newest app (native/), released on its own: the page tells people on an older one where to get it.
const nativeVersion = readFileSync(new URL('./native/VERSION', import.meta.url), 'utf8').trim()

export default defineConfig({
  base: './',
  plugins: [vue()],
  define: { __APP_VERSION__: JSON.stringify(version), __NATIVE_VERSION__: JSON.stringify(nativeVersion) },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
  },
  build: {
    target: 'es2022',
    // The app's overlay window has a page of its own (overlay.html), with only the table in it.
    rollupOptions: { input: { main: 'index.html', overlay: 'overlay.html' } }
  },
  server: {
    host: true,
    // Same cross-origin isolation the Worker gives the real site (worker/index.ts).
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    // The rooms and /api/ice are the Worker's: `npm run dev` runs it on 8787 (scripts/dev.mjs).
    proxy: { '/api': { target: 'http://127.0.0.1:8787', ws: true } }
  },
  preview: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
  test: {
    environment: 'node',
    // The Worker's runtime module, for testing the room outside workerd.
    alias: { 'cloudflare:workers': fileURLToPath(new URL('./tests/stubs/cloudflare-workers.ts', import.meta.url)) },
    include: ['tests/**/*.test.ts']
  }
})
