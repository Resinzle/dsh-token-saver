// Verify the deferring half of the race guard.
//
// Reproduces the exact live failure: the DSH launcher has already claimed the
// start marker and is bringing the server up, while the plugin's first health
// probe still fails because the port is not listening yet. ensureServer must
// WAIT for that server rather than spawn a second copy.
//
// This is the ordering that actually produced the duplicate on 2026-09-21:
// llama-server started 23:05:29, DSH booted 23:05:32, and a second server was
// spawned into the warmup window.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureServer, health } from 'dsh-plugin-local-offload/lib/http.js'

const client = { baseUrl: 'http://127.0.0.1:18080', model: 'local-qwen3-8b', apiKey: 'local-no-key', timeoutMs: 600_000 }
const marker = join(tmpdir(), 'dsh-local-ai.starting')
const serverExe = 'F:\\bonsai\\bin\\llama-official-vulkan\\llama-server.exe'
const modelPath = 'F:\\bonsai\\models\\Ternary-Bonsai-8B-Q2_0_g64.gguf'

function countServers() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "(Get-Process llama-server -ErrorAction SilentlyContinue | Measure-Object).Count"], { encoding: 'utf8' })
  return Number((r.stdout ?? '0').trim()) || 0
}

console.log('--- setup: no server, no marker ---')
spawnSync('powershell.exe', ['-NoProfile', '-Command',
  "Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force"], { encoding: 'utf8' })
if (existsSync(marker)) unlinkSync(marker)
await new Promise((r) => setTimeout(r, 3000))
console.log(`  llama-server count: ${countServers()}`)

console.log('\n--- simulate the launcher owning the start (marker written, server loading) ---')
// The marker is what the launcher writes before it spawns anything.
writeFileSync(marker, 'simulated-launcher', 'utf8')
const child = spawn(serverExe, ['-m', modelPath, '-ngl', '99', '-c', '32768', '-a', 'local-qwen3-8b',
  '--host', '127.0.0.1', '--port', '18080', '-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0', '-np', '1',
  '--jinja', '--reasoning-format', 'none'], { detached: true, stdio: 'ignore', windowsHide: true })
child.unref()
console.log(`  simulated launcher spawned pid ${child.pid}; marker present`)

// The port is not listening yet. ensureServer must defer, not spawn.
const t0 = Date.now()
const result = await ensureServer(client, 120_000)
const secs = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`  ensureServer -> ${JSON.stringify(result)}  (${secs}s)`)
console.log(`  reported "started" (i.e. spawned its own): ${result.started}`)

await new Promise((r) => setTimeout(r, 3000))
const count = countServers()
const post = await health(client, AbortSignal.timeout(4000))
console.log(`\n  server after: ${post.ok ? 'UP' : 'DOWN'}`)
console.log(`  llama-server count: ${count}`)

// Clean up the marker we planted so the real launcher is unaffected.
if (existsSync(marker)) unlinkSync(marker)

if (count === 1 && post.ok && result.started === false) {
  console.log('\nDEFER GUARD: PASS (waited for the other starter, no duplicate)')
} else if (count > 1) {
  console.log(`\nDEFER GUARD: FAIL (${count} servers -- it spawned a duplicate)`)
  process.exitCode = 1
} else {
  console.log(`\nDEFER GUARD: FAIL (count=${count}, started=${result.started}, healthy=${post.ok})`)
  process.exitCode = 1
}
