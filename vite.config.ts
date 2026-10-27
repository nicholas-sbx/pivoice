/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Shown on the start screen; each release bumps it in package.json.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  base: './',
  plugins: [vue()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
  },
  build: { target: 'es2022' },
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
