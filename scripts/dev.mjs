// `npm run dev`: the app (Vite, with hot reload) and the Worker (`wrangler
// dev`, with the rooms' Durable Objects running locally) side by side. Vite
// passes /api, WebSockets included, through to the Worker (vite.config.ts).
// Ctrl+C stops both.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'

// wrangler won't start without the assets directory; Vite serves the real files in dev.
mkdirSync('dist', { recursive: true })

const children = [
  spawn('npx', ['wrangler', 'dev', '--port', '8787', '--ip', '127.0.0.1', '--show-interactive-dev-session=false'], { stdio: 'inherit' }),
  spawn('npx', ['vite', ...process.argv.slice(2)], { stdio: 'inherit' })
]

let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM')
  process.exitCode = code
}
for (const c of children) c.on('exit', code => stop(code ?? 0))
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
