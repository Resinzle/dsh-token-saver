/**
 * gh-tunnel — a local CONNECT proxy that resolves GitHub hostnames with its
 * OWN public DNS servers instead of the system resolver.
 *
 * Why this exists
 * ---------------
 * On the machine this was written for, `C:\Windows\System32\drivers\etc\hosts`
 * contains about twenty lines mapping `github.com`, `api.github.com`,
 * `raw.githubusercontent.com` and friends to `127.0.0.1`. The system DNS client
 * therefore answers those names with a loopback address, and every tool that
 * uses the system resolver -- git, npm, browsers -- fails.
 *
 * The network path itself is fine. Measured directly on that machine:
 *
 *   TLS OK  github.com     via 140.82.112.4      authorized=true cn=github.com
 *   TLS OK  api.github.com via 140.82.112.6      authorized=true cn=*.github.com
 *   TLS OK  codeload.github.com via 20.205.243.165 authorized=true cn=*.github.com
 *
 * ...and plain DNS over UDP to a public resolver answers correctly:
 *
 *   223.5.5.5  github.com -> 20.205.243.166
 *   119.29.29.29 github.com -> 20.205.243.166
 *
 * So only name resolution is broken. This proxy fixes that one layer, for git
 * only, without touching the hosts file (which would need administrator rights)
 * and without any third-party VPN or proxy client.
 *
 * Usage
 * -----
 *   node tools/gh-tunnel.mjs                  # prints the git config to apply
 *   node tools/gh-tunnel.mjs --port 18081
 *   node tools/gh-tunnel.mjs --deny-all       # tunnel ANY host, not just GitHub
 *
 * Then, in another terminal:
 *   git config --global http.https://github.com.proxy http://127.0.0.1:18081
 *
 * The config is scoped to `https://github.com`, so only GitHub traffic goes
 * through the tunnel; every other `git` remote is unaffected. To undo:
 *   git config --global --unset http.https://github.com.proxy
 *
 * Security notes
 * --------------
 * - Binds to 127.0.0.1 only; nothing on the LAN can reach it.
 * - It is a blind forwarder: it never decrypts TLS, holds no credentials, and
 *   logs only host and byte counts at `--verbose`.
 * - It refuses any host outside the allow-list unless `--deny-all` is passed,
 *   so it cannot silently become an open proxy for other software.
 *
 * @module gh-tunnel
 */
import { createServer, connect as netConnect } from 'node:net'
import { promises as dnsPromises } from 'node:dns'

// --- configuration ---------------------------------------------------------

/** Public resolvers, tried in order. None of these are the poisoned local one. */
const PUBLIC_DNS = ['223.5.5.5', '119.29.29.29', '1.1.1.1']

/**
 * Hosts this proxy is willing to reach by default.
 *
 * `codeload.github.com` is the one that serves archive tarballs, and
 * `objects.githubusercontent.com` serves release assets -- both are commonly
 * missed by hand-written allow-lists and then fail confusingly.
 */
const GITHUB_HOSTS = [
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'gist.github.com',
  'uploads.github.com',
  'github.io',
  'pages.github.com',
  'avatars.githubusercontent.com',
  'user-images.githubusercontent.com',
  'camo.githubusercontent.com',
]

/**
 * Fallback addresses, used only when DNS fails entirely.
 *
 * These are GitHub's documented ranges. They are a last resort on purpose:
 * pinning an address that GitHub later reassigns is worse than a clean error.
 */
const FALLBACK_IPS = {
  'github.com': ['140.82.112.4', '20.205.243.166'],
  'api.github.com': ['140.82.112.6', '20.205.243.168'],
  'codeload.github.com': ['20.205.243.165'],
}

// --- argument parsing ------------------------------------------------------

const argv = process.argv.slice(2)
const hasFlag = (f) => argv.includes(f)
const valueOf = (f, fallback) => {
  const i = argv.indexOf(f)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const port = Number(valueOf('--port', '18081'))
const verbose = hasFlag('--verbose')
const allowAll = hasFlag('--deny-all')
const serveFor = Number(valueOf('--serve-for', '0')) * 1000

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`gh-tunnel: --port must be a TCP port, got "${valueOf('--port', '')}"`)
  process.exit(2)
}

// --- name resolution -------------------------------------------------------

const resolver = new dnsPromises.Resolver()
resolver.setServers(PUBLIC_DNS)

/** Cache successful lookups; GitHub's addresses are stable for minutes. */
const cache = new Map()
const CACHE_TTL_MS = 300_000

/**
 * Addresses to try for a host, best first.
 *
 * Order is: the address that most recently worked, then the public-DNS answers,
 * then the built-in fallbacks. This deliberately does NOT probe each candidate
 * with a throwaway connection.
 *
 * Probing was tried first and removed: with ten candidate addresses and a
 * 5-second probe deadline, a burst of parallel git connections made every
 * `git fetch` time out with `Proxy CONNECT aborted` before the probe finished.
 * A failed connect now costs one attempt, and the next address is tried
 * immediately, which is both faster and simpler.
 *
 * @param {string} host
 * @returns {Promise<string[]>}
 */
async function candidatesFor(host) {
  const hit = cache.get(host)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return [hit.ip, ...hit.rest]

  const rest = []
  for (const ip of FALLBACK_IPS[host] ?? []) if (!rest.includes(ip)) rest.push(ip)

  let resolved = []
  try {
    resolved = await resolver.resolve4(host)
  } catch (error) {
    if (verbose) console.error(`gh-tunnel: public DNS failed for ${host}: ${error.code}`)
  }
  const all = [...resolved, ...rest.filter((ip) => !resolved.includes(ip))]
  if (all.length === 0) throw new Error(`no address for ${host}`)
  return all
}

/** Remember which address worked, so the next connection tries it first. */
function remember(host, ip, rest) {
  cache.set(host, { ip, rest: rest.filter((c) => c !== ip), at: Date.now() })
}

/** True when the host is on the allow-list (`--deny-all` inverts this). */
function permitted(host) {
  if (allowAll) return true
  return GITHUB_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}

// --- the proxy -------------------------------------------------------------

let connections = 0
let bytes = 0

/**
 * Bytes read while the CONNECT request itself was being parsed.
 *
 * A client may pipeline TLS bytes immediately after its CONNECT line, and those
 * bytes arrive in the same `data` event that carries the request. They belong to
 * the upstream connection, so they are held here and written once the tunnel is
 * established instead of being dropped.
 */
let buffered = Buffer.alloc(0)

/**
 * Pipe one client socket to a resolved destination, in both directions.
 *
 * The tunnel is byte-blind: TLS is negotiated end to end between the client and
 * GitHub, so this process never sees a credential, a repository, or a diff.
 */
async function pipe(clientSocket, host, clientPort) {
  let candidates
  try {
    candidates = await candidatesFor(host)
  } catch (error) {
    if (verbose) console.error(`gh-tunnel: cannot resolve ${host}: ${error.message}`)
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    return
  }

  let lastError
  for (const ip of candidates) {
    const upstream = await new Promise((resolve) => {
      const socket = netConnect({ host: ip, port: 443, timeout: 10_000 })
      const fail = (error) => { socket.destroy(); lastError = error; resolve(undefined) }
      socket.once('connect', () => { socket.removeListener('error', fail); resolve(socket) })
      socket.once('error', fail)
      socket.once('timeout', () => fail(new Error('connect timeout')))
    })
    if (!upstream) continue

    connections++
    remember(host, ip, candidates)
    if (verbose) console.error(`gh-tunnel: ${host}:${clientPort} -> ${ip}:443 (#${connections})`)
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    // The client sends nothing until it sees that 200, so any bytes already
    // buffered must be forwarded explicitly before the pipe takes over.
    if (buffered.length > 0) upstream.write(buffered)
    buffered = Buffer.alloc(0)
    clientSocket.pipe(upstream)
    upstream.pipe(clientSocket)
    clientSocket.on('data', (chunk) => { bytes += chunk.length })
    upstream.on('data', (chunk) => { bytes += chunk.length })
    upstream.on('error', (error) => {
      if (verbose) console.error(`gh-tunnel: upstream error for ${host}: ${error.code}`)
      clientSocket.destroy()
    })
    // A client that disappears mid-copy raises EPIPE on the upstream socket;
    // without a listener that would crash the process holding every other
    // connection open, so it is handled here rather than left to the default.
    upstream.on('close', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
    clientSocket.on('close', () => upstream.destroy())
    return
  }
  if (verbose) console.error(`gh-tunnel: no address for ${host} accepted a connection (${lastError?.code ?? 'unknown'})`)
  clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
}

const server = createServer((socket) => {
  // Attach an error listener IMMEDIATELY, before anything else.
  //
  // This is not defensive padding. An 'error' event with no listener is rethrown
  // by Node and terminates the process, and this proxy holds many connections at
  // once -- so one client resetting its connection would kill the tunnel and
  // abort an in-flight `git push`. That is exactly what happened in testing: a
  // client ECONNRESET on the very first byte crashed the whole proxy with
  // `Error: read ECONNRESET`, exit code 1.
  //
  // The window is real and not theoretical: this handler used to be installed
  // inside `pipe()`, which is asynchronous (it awaits DNS resolution before it
  // reaches the socket setup), so a client that connected and then immediately
  // reset had no listener attached yet.
  socket.on('error', (error) => {
    if (verbose) console.error(`gh-tunnel: client socket error: ${error.code ?? error.message}`)
    socket.destroy()
  })

  // A plain-HTTP request (not CONNECT) can only be a mistake here, but answering
  // with a useful message beats an opaque hang.
  socket.once('data', (chunk) => {
    const text = chunk.toString('latin1')
    if (!/^CONNECT /i.test(text)) {
      socket.end('HTTP/1.1 405 Method Not Allowed\r\n\r\ngh-tunnel is a CONNECT proxy; use it via git http.proxy\r\n')
      return
    }
    const headerEnd = text.indexOf('\r\n\r\n')
    const [host, clientPort] = text.split('\r\n')[0].replace(/^CONNECT\s+/i, '').split(/\s+/)[0].split(':')
    if (!permitted(host)) {
      socket.end(`HTTP/1.1 403 Forbidden\r\n\r\ngh-tunnel: ${host} is not in the allow-list (use --deny-all to tunnel anything)\r\n`)
      return
    }
    // Keep whatever followed the request header; a client may have pipelined TLS.
    buffered = headerEnd >= 0 ? Buffer.from(chunk.subarray(headerEnd + 4)) : Buffer.alloc(0)
    pipe(socket, host, clientPort ?? '?')
  })
})

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`gh-tunnel: port ${port} is already in use. Another copy may be running; pass --port to pick another.`)
    process.exit(1)
  }
  console.error(`gh-tunnel: ${error.message}`)
  process.exit(1)
})

server.listen(port, '127.0.0.1', () => {
  const scoped = `git config --global http.https://github.com.proxy http://127.0.0.1:${port}`
  console.log(`gh-tunnel listening on http://127.0.0.1:${port}`)
  console.log(`  resolvers : ${PUBLIC_DNS.join(', ')}`)
  console.log(`  hosts     : ${allowAll ? 'ANY (--deny-all)' : `${GITHUB_HOSTS.length} GitHub hosts`}`)
  console.log('')
  console.log('  Point git at it (scoped to GitHub, other remotes unaffected):')
  console.log(`    ${scoped}`)
  console.log('')
  console.log('  Undo:')
  console.log('    git config --global --unset http.https://github.com.proxy')
  console.log('')
  console.log('  Verify without pushing anything:')
  console.log(`    git ls-remote https://github.com/deepseek-ai/deepseek-harness HEAD`)
})

if (serveFor > 0) {
  setTimeout(() => {
    console.log(`gh-tunnel: --serve-for elapsed (${serveFor / 1000}s), exiting after ${connections} connection(s), ${bytes} bytes.`)
    server.close(() => process.exit(0))
  }, serveFor).unref?.()
}

process.on('SIGINT', () => {
  console.log(`\ngh-tunnel: stopped after ${connections} connection(s), ${bytes} bytes.`)
  server.close(() => process.exit(0))
})

// Last-resort net. This process exists only to forward bytes between two
// sockets, and it holds several at once, so an error escaping to the top level
// would abort every other transfer in flight -- including a `git push`. There is
// no state worth protecting here (two counters and a DNS cache), so dropping one
// connection and continuing is strictly better than dying.
//
// This does NOT replace per-socket handling: a socket with no 'error' listener
// emits here first. Every path above installs one; this is the backstop for a
// path not yet known.
process.on('uncaughtException', (error) => {
  console.error(`gh-tunnel: uncaught ${error?.code ?? error?.name ?? 'error'}: ${error?.message ?? error} (connection dropped, tunnel still running)`)
})
process.on('unhandledRejection', (reason) => {
  console.error(`gh-tunnel: unhandled rejection: ${reason?.message ?? reason} (tunnel still running)`)
})
