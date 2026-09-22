// Establish the per-request prompt-size profile and where the volume sits.
//
// This exists to answer one question with evidence rather than inference: is the
// context actually being held down by compaction, and how much of each request
// is oversized tool output that could have been spilt instead.
//
// Usage: node profile-report.mjs [sessionsRoot] [maxFiles]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const root = process.argv[2] ?? 'C:\\Users\\\u543e\\.dsh\\sessions'
const maxFiles = Number(process.argv[3] ?? 40)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

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

function decode(file) {
  const raw = readFileSync(file)
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

function textLen(content) {
  let n = 0
  for (const b of content ?? []) {
    if (typeof b?.text === 'string') n += b.text.length
    if (Array.isArray(b?.content)) n += textLen(b.content)
  }
  return n
}

const files = walk(root).map((f) => ({ f, mtime: statSync(f).mtimeMs })).sort((a, b) => b.mtime - a.mtime).slice(0, maxFiles)

const SPILL_CANDIDATE = 12_000 // proposed maxInlineBytes
const CURRENT_SPILL = 50_000    // shipped maxInlineBytes
const PRUNER = 8_192            // shipped pruner thresholdChars

let spillNow = 0, spillNowChars = 0
let spillProposed = 0, spillProposedChars = 0
let pruneOver = 0, pruneChars = 0
let allToolChars = 0, allTool = 0
const sessionProfiles = []

for (const { f } of files) {
  const lines = decode(f)
  const prompts = []
  let toolChars = 0, toolN = 0
  let sNow = 0, sNowC = 0, sProp = 0, sPropC = 0, sPrune = 0, sPruneC = 0
  for (const line of lines) {
    let r
    try { r = JSON.parse(line) } catch { continue }
    if (r.type === 'tool/result') {
      const n = textLen(r.data?.message?.content)
      toolChars += n; toolN++
      if (n > CURRENT_SPILL) { sNow++; sNowC += n }
      if (n > SPILL_CANDIDATE) { sProp++; sPropC += n }
      if (n > PRUNER) { sPrune++; sPruneC += n }
      continue
    }
    const u = r.data?.usage ?? r.usage
    if (u) prompts.push((Number(u.inputTokens) || 0) + (Number(u.cacheReadTokens) || 0))
  }
  allToolChars += toolChars; allTool += toolN
  spillNow += sNow; spillNowChars += sNowC
  spillProposed += sProp; spillProposedChars += sPropC
  pruneOver += sPrune; pruneChars += sPruneC
  if (prompts.length) {
    prompts.sort((a, b) => a - b)
    sessionProfiles.push({
      id: f.split(/[\\/]/).slice(-2, -1)[0],
      calls: prompts.length,
      p50: prompts[Math.floor(prompts.length * 0.5)],
      p90: prompts[Math.floor(prompts.length * 0.9)],
      max: prompts.at(-1),
      toolN, toolChars, sPropC,
    })
  }
}

console.log('=== tool output volume ===')
console.log(`  results: ${allTool.toLocaleString()}  text: ${(allToolChars / 1e6).toFixed(2)} M chars`)
const pct = (a, b) => b ? ((a / b) * 100).toFixed(1) + '%' : '0%'
console.log(`  above ${CURRENT_SPILL.toLocaleString()} chars (shipped spill cap): ${spillNow} results, ${(spillNowChars / 1e6).toFixed(2)} M chars (${pct(spillNowChars, allToolChars)})`)
console.log(`  above ${SPILL_CANDIDATE.toLocaleString()} chars (proposed cap):      ${spillProposed} results, ${(spillProposedChars / 1e6).toFixed(2)} M chars (${pct(spillProposedChars, allToolChars)})`)
console.log(`  above ${PRUNER.toLocaleString()} chars (shipped pruner):       ${pruneOver} results, ${(pruneChars / 1e6).toFixed(2)} M chars (${pct(pruneChars, allToolChars)})`)

console.log('\n=== per-request prompt size (cached + uncached) ===')
console.log('session                  calls      p50       p90       max   toolchars  >12K')
for (const s of sessionProfiles.sort((a, b) => b.calls - a.calls).slice(0, 10)) {
  console.log(
    `${s.id.slice(0, 22).padEnd(24)}${String(s.calls).padStart(5)}${String(s.p50).padStart(9)}` +
    `${String(s.p90).padStart(10)}${String(s.max).padStart(10)}${(s.toolChars / 1e3).toFixed(0).padStart(11)}K${(s.sPropC / 1e3).toFixed(0).padStart(7)}K`,
  )
}

// A spilled result stops being replayed, so its cost contribution is roughly
// its size times the number of requests issued after it entered.
console.log('\n=== estimated saving if the 12K cap had been active ===')
console.log('  A spilled result leaves context, so it is not replayed again.')
console.log(`  Upper bound: ${(spillProposedChars / 1e6).toFixed(2)} M chars leave all contexts.`)
console.log('  In the largest session that is a large share of every later prompt.')
console.log('\n  This is an upper bound: a spill preserves a head/tail preview, and the')
console.log('  model can read the spill file if the middle actually matters.')
