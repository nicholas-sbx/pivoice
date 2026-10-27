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
  // Same cross-origin isolation the Worker gives the real site (worker/index.ts).
  server: { host: true, headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
  preview: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
})
