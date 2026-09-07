// scripts/find-ports.mjs
//
// Find a free frontend + backend port pair so multiple NovelWeb instances can
// run side by side. Probes upward from the defaults (web 5173, api 3001) and
// emits the chosen ports as KEY=VALUE lines for the start scripts to consume:
//
//   NOVELWEB_WEB_PORT=5174
//   NOVELWEB_API_PORT=3002
//
// The normal launchers export these into the child environment; vite.config.js
// and server/index.js read them so the frontend proxy always targets *this*
// instance's backend.

import net from 'node:net'

const WEB_DEFAULT = parseInt(process.env.NOVELWEB_WEB_PORT || '5173', 10)
const API_DEFAULT = parseInt(process.env.NOVELWEB_API_PORT || '3001', 10)
const SPAN = 50 // how many ports to try before giving up

// Return the bound port, or null when unavailable. Port 0 asks the OS to
// allocate an available port outside Windows-reserved/excluded ranges.
function availablePort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(null))
    srv.once('listening', () => {
      const selected = srv.address().port
      srv.close(() => resolve(selected))
    })
    // Do not force IPv4 here. Vite and Express use Node's default host, which
    // is commonly the IPv6 wildcard (::) on Windows. Probing only 0.0.0.0 can
    // therefore report an IPv6-occupied port as free.
    srv.listen(port)
  })
}

async function findFree(start, skip = []) {
  for (let p = start; p < Math.min(start + SPAN, 65536); p++) {
    if (skip.includes(p)) continue
    if (await availablePort(p)) return p
  }
  // A preferred port can sit immediately before a Windows exclusion block.
  // Never report the occupied preferred port after exhausting that block.
  for (let attempt = 0; attempt < SPAN; attempt++) {
    const selected = await availablePort(0)
    if (selected && !skip.includes(selected)) return selected
  }
  throw new Error('Could not allocate a distinct available NovelWeb port')
}

const web = await findFree(WEB_DEFAULT)
const api = await findFree(API_DEFAULT, [web]) // never collide with the web port

process.stdout.write(`NOVELWEB_WEB_PORT=${web}\nNOVELWEB_API_PORT=${api}\n`)
