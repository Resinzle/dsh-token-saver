// Reproduce the startup race and prove the shared marker prevents a duplicate.
//
// Runs both start paths at the same instant -- the DSH launcher's PowerShell
// block and the plugin's ensureServer -- then counts llama-server processes.
// Exactly one must survive; two means both spawned, which is the bug this
// guard exists to prevent (each copy costs ~3.6GB of the card's 8GB).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureServer, health } from 'dsh-plugin-local-offload/lib/http.js'

const client = { baseUrl: 'http://127.0.0.1:18080', model: 'local-qwen3-8b', apiKey: 'local-no-key', timeoutMs: 600_000 }
const marker = join(tmpdir(), 'dsh-local-ai.starting')
const launcherPath = 'C:\\Users\\\u543e\\OneDrive\\\u6587\u6863\\\u5343\u661f\u5947\u57df\\dsh-launcher.ps1'

function countServers() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "(Get-Process llama-server -ErrorAction SilentlyContinue | Measure-Object).Count"], { encoding: 'utf8' })
  return Number((r.stdout ?? '0').trim()) || 0
}

// Extract the real Start-LocalAi block from the launcher and run it in its own
// PowerShell process, exactly as the launcher would.
const extraction = [
  `$text = [System.IO.File]::ReadAllText('${launcherPath}')`,
  "$start = $text.IndexOf('function Test-LocalAiPort')",
  "$end = $text.IndexOf('# Start the local model before DSH')",
  "if ($start -lt 0 -or $end -lt 0) { throw 'block not found' }",
  'Invoke-Expression $text.Substring($start, $end - $start)',
  'Start-LocalAi',
].join('\n')
const extractionPath = join(tmpdir(), 'race-launcher.ps1')
writeFileSync(extractionPath, extraction, 'utf8')

console.log('--- setup: service stopped, marker cleared ---')
spawnSync('powershell.exe', ['-NoProfile', '-Command',
  "Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force"], { encoding: 'utf8' })
if (existsSync(marker)) unlinkSync(marker)
await new Promise((r) => setTimeout(r, 3000))
const pre = await health(client, AbortSignal.timeout(3000))
console.log(`  server before: ${pre.ok ? 'UP (test invalid -- stop it first)' : 'DOWN'}`)
console.log(`  llama-server count: ${countServers()}`)

console.log('\n--- firing both start paths simultaneously ---')
const launcher = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', extractionPath],
  { detached: true, stdio: 'ignore', windowsHide: true })
launcher.unref()

const results = await Promise.allSettled([ensureServer(client, 120_000)])
console.log(`  ensureServer: ${JSON.stringify(results[0].value ?? results[0].reason?.message)}`)

// Let any late duplicate finish binding (or fail to).
await new Promise((r) => setTimeout(r, 6000))
const count = countServers()
const post = await health(client, AbortSignal.timeout(4000))
console.log(`\n  server after: ${post.ok ? 'UP' : 'DOWN'}`)
console.log(`  llama-server count: ${count}`)
console.log(`  marker left behind: ${existsSync(marker)}`)

if (existsSync(extractionPath)) unlinkSync(extractionPath)

if (count === 1 && post.ok) console.log('\nRACE GUARD: PASS (exactly one server)')
else if (count > 1) { console.log(`\nRACE GUARD: FAIL (${count} servers -- duplicate spawned)`); process.exitCode = 1 }
else { console.log(`\nRACE GUARD: INCONCLUSIVE (count=${count}, healthy=${post.ok})`); process.exitCode = 1 }
