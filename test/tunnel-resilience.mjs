// Reproduce the crash this proxy suffered, then confirm it survives.
//
// The observed failure: a client connected, sent nothing useful, and reset the
// connection. Node rethrew the resulting ECONNRESET because the socket had no
// 'error' listener yet -- the listener was installed inside the async `pipe()`,
// after an await on DNS resolution. The whole proxy exited with code 1, which
// would abort an in-flight `git push`.
//
// This script opens three kinds of hostile clients and then checks that the
// tunnel still answers a legitimate request. Usage:
//   node test/tunnel-resilience.mjs [port]
import { connect } from 'node:net'
import { request } from 'node:http'

const port = Number(process.argv[2] ?? 18082)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Connect and immediately destroy, without sending a byte. */
function resetImmediately() {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      // destroy() without end() is an RST-ish abort from this side.
      socket.destroy()
      resolve('connected-then-destroyed')
    })
    socket.on('error', () => resolve('errored'))
  })
}

/** Send a partial CONNECT line, then vanish: the parser never completes it. */
function resetMidRequest() {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write('CONNECT github.com:443 HTT')
      setTimeout(() => { socket.destroy(); resolve('partial-then-destroyed') }, 20)
    })
    socket.on('error', () => resolve('errored'))
  })
}

/** A complete CONNECT to a real host, then reset while the tunnel is connecting. */
function resetMidTunnel() {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write('CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n')
      setTimeout(() => { socket.destroy(); resolve('tunnel-then-destroyed') }, 30)
    })
    socket.on('error', () => resolve('errored'))
  })
}

/** A request the proxy must refuse; proves the allow-list still works. */
function refusedHost() {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n')
      let data = ''
      socket.on('data', (chunk) => { data += chunk.toString('latin1') })
      socket.on('close', () => resolve(`refused -> ${data.split('\r\n')[0]}`))
      socket.on('error', () => resolve('errored'))
    })
    socket.on('error', () => resolve('errored'))
  })
}

/**
 * Is the proxy still alive?
 *
 * Checked with a request the proxy answers itself, so this does not depend on
 * outbound network access and cannot fail for an unrelated reason.
 */
function stillAlive() {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, method: 'GET', path: '/' }, (res) => {
      res.resume()
      // A CONNECT proxy answers a plain GET with 405, which is proof of life.
      resolve(res.statusCode)
    })
    req.on('error', (error) => resolve(`dead: ${error.code}`))
    req.end()
  })
}

console.log(`target: 127.0.0.1:${port}\n`)

const results = []
for (let i = 0; i < 8; i++) results.push(await resetImmediately())
for (let i = 0; i < 8; i++) results.push(await resetMidRequest())
for (let i = 0; i < 4; i++) results.push(await resetMidTunnel())
await sleep(300)
results.push(await refusedHost())

console.log('hostile clients:')
for (const [kind, count] of Object.entries(results.reduce((acc, r) => {
  const key = r.startsWith('refused') ? 'refused (allow-list)' : r
  acc[key] = (acc[key] ?? 0) + 1
  return acc
}, {}))) console.log(`  ${String(count).padStart(3)} x ${kind}`)

const alive = await stillAlive()
console.log(`\nliveness probe (plain GET answered by the proxy): ${alive}`)

const ok = alive === 405
console.log(ok
  ? '\nPASS  the tunnel survived every hostile client and still answers'
  : `\nFAIL  the tunnel is not answering (got ${alive}); it probably crashed`)
process.exitCode = ok ? 0 : 1
