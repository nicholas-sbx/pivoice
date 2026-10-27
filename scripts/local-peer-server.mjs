// A self-hosted PeerJS broker for development (or if you'd rather not use the cloud one).
//   npm run peer:local
// then `npm run dev:local`, which points the app at it (see .env.localpeer).
import { PeerServer } from 'peer'

const port = Number(process.env.PORT ?? 9000)
const host = process.env.HOST ?? '0.0.0.0'
const server = PeerServer({ port, host, path: '/pivoice', allow_discovery: false })
server.on('connection', client => console.log('peer connected', client.getId()))
server.on('disconnect', client => console.log('peer left', client.getId()))
console.log(`PeerJS broker listening on http://localhost:${port}/pivoice`)
