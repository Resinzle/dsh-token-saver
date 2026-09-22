// Cost attribution from DSH session logs, using published DeepSeek pricing.
//
// The confusing part of these logs is that `inputTokens` is the UNCACHED
// portion while `cacheReadTokens` is the reused prefix, so "input" alone is not
// the bill. This script reports the three metered columns that actually price a
// session, and shows the per-request prompt size distribution, because that
// distribution is what a compaction threshold controls.
//
// Usage: node cost-report.mjs [sessionsRoot] [maxFiles] [peak|offpeak]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const root = process.argv[2] ?? 'C:\\Users\\\u543e\\.dsh\\sessions'
const maxFiles = Number(process.argv[3] ?? 60)
const window = process.argv[4] ?? 'offpeak'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// deepseek-flash, per 1M tokens (DeepSeek published pricing).
const PRICE = window === 'peak'
  ? { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 }
  : { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 }

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.jsonl.zstd')) out.push(p)
  }
  return out
}

function decode(raw) {
  const offs = []
  let i = 0
  while (i < raw.length - 4) { const k = raw.indexOf(MAGIC, i); if (k === -1) break; offs.push(k); i = k + 4 }
  const lines = []
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : raw.length
    try { for (const l of zstdDecompressSync(raw.subarray(offs[k], end)).toString('utf8').split('\n')) if (l.trim()) lines.push(l) } catch { /* skip */ }
  }
  return lines
}

const files = walk(root).map((f) => ({ f, mtime: statSync(f).mtimeMs })).sort((a, b) => b.mtime - a.mtime).slice(0, maxFiles)

let uncached = 0, cached = 0, output = 0, reasoning = 0, calls = 0
const promptSizes = []
const perSession = []

for (const { f } of files) {
  const lines = decode(readFileSync(f))
  let sU = 0, sC = 0, sO = 0, sR = 0, sN = 0
  for (const line of lines) {
    let r; try { r = JSON.parse(line) } catch { continue }
    const u = r.data?.usage ?? r.usage
    if (!u) continue
    const i = Number(u.inputTokens ?? 0) || 0
    const c = Number(u.cacheReadTokens ?? 0) || 0
    const o = Number(u.outputTokens ?? 0) || 0
    const g = Number(u.reasoningTokens ?? 0) || 0
    if (i === 0 && o === 0 && c === 0) continue
    sU += i; sC += c; sO += o; sR += g; sN++
    promptSizes.push(i + c)
  }
  if (sN === 0) continue
  perSession.push({ id: f.split(/[\\/]/).slice(-2, -1)[0], uncached: sU, cached: sC, output: sO, reasoning: sR, calls: sN })
  uncached += sU; cached += sC; output += sO; reasoning += sR; calls += sN
}

const prompt = uncached + cached
const cost = {
  cacheHit: (cached / 1e6) * PRICE.cacheHit,
  cacheMiss: (uncached / 1e6) * PRICE.cacheMiss,
  output: (output / 1e6) * PRICE.output,
}
const total = cost.cacheHit + cost.cacheMiss + cost.output

console.log(`pricing window: ${window} (deepseek-flash: hit $${PRICE.cacheHit} / miss $${PRICE.cacheMiss} / out $${PRICE.output} per 1M)\n`)
console.log('session                  calls   prompt tok   cached tok   hit%    out tok     cost $')
for (const s of perSession.sort((a, b) => (b.cached + b.uncached) - (a.cached + a.uncached)).slice(0, 10)) {
  const p = s.cached + s.uncached
  const c = (s.cached / 1e6) * PRICE.cacheHit + (s.uncached / 1e6) * PRICE.cacheMiss + (s.output / 1e6) * PRICE.output
  console.log(
    `${s.id.slice(0, 22).padEnd(24)}${String(s.calls).padStart(5)}${String(p).padStart(13)}` +
    `${String(s.cached).padStart(13)}${((s.cached / p) * 100).toFixed(1).padStart(7)}` +
    `${String(s.output).padStart(10)}${c.toFixed(3).padStart(11)}`,
  )
}

console.log('\n=== bill attribution ===')
const rows = [
  ['cached input (cache hit)', cached, PRICE.cacheHit, cost.cacheHit],
  ['uncached input (cache miss)', uncached, PRICE.cacheMiss, cost.cacheMiss],
  ['output', output, PRICE.output, cost.output],
]
for (const [label, tokens, rate, c] of rows) {
  const share = total ? ((c / total) * 100).toFixed(1) : '0'
  console.log(`  ${label.padEnd(28)} ${String(tokens).padStart(12)} tok  $${c.toFixed(3).padStart(8)}  (${share}%)`)
}
console.log(`  ${'TOTAL'.padEnd(28)} ${String(prompt + output).padStart(12)} tok  $${total.toFixed(3).padStart(8)}`)
console.log(`\n  cache hit rate: ${((cached / prompt) * 100).toFixed(1)}%`)
console.log(`  reasoning tokens inside output: ${reasoning.toLocaleString()} (${((reasoning / Math.max(output, 1)) * 100).toFixed(1)}% of output)`)
console.log(`  total requests: ${calls}`)

promptSizes.sort((a, b) => a - b)
const pick = (q) => promptSizes[Math.min(promptSizes.length - 1, Math.floor(promptSizes.length * q))] ?? 0
console.log('\n=== per-request prompt size (cached + uncached) ===')
console.log(`  min ${pick(0).toLocaleString()}   p50 ${pick(0.5).toLocaleString()}   p90 ${pick(0.9).toLocaleString()}   p99 ${pick(0.99).toLocaleString()}   max ${pick(1).toLocaleString()}`)
const over = (n) => promptSizes.filter((s) => s > n).length
console.log(`  requests above 100K prompt tokens: ${over(100000)} / ${promptSizes.length}`)
console.log(`  requests above 200K prompt tokens: ${over(200000)} / ${promptSizes.length}`)
console.log('\n  Reducing the replay volume is a cache-hit cost lever, not a cache-miss one:')
console.log(`  every 1M tokens removed from the replayed prefix saves $${PRICE.cacheHit} at this window.`)
