// Count model requests per human turn, per session.
//
// This exists because the per-turn request count, not the context size, is the
// lever a user actually controls. Prompt volume is approximately
//
//     average context size x number of requests
//
// and a session's request count is decided by how many tool calls the loop made,
// each of which replays the whole transcript. A session can be made cheap by
// using fewer, better-aimed tool calls even when it is long.
//
// Usage: node test/turns-report.mjs [sessionsRoot] [maxFiles]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const root = process.argv[2] ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'sessions')
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
  while (i < raw.length - 4) {
    const k = raw.indexOf(MAGIC, i)
    if (k === -1) break
    offs.push(k)
    i = k + 4
  }
  const lines = []
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : raw.length
    try {
      for (const l of zstdDecompressSync(raw.subarray(offs[k], end)).toString('utf8').split('\n')) if (l.trim()) lines.push(l)
    } catch { /* skip unreadable frame */ }
  }
  return lines
}

/**
 * A human turn is counted from the log's own `turn/start` record.
 *
 * Inferring turns from user-role messages was tried first and was wrong twice:
 * the record type is `user/message` (not `message/user`), and the same session
 * also carries `agent/inbox/spliced` injections and tool results on the user
 * side, so a message-shaped heuristic both misses turns and invents them.
 * `turn/start` is emitted once per turn by the loop, which makes it the
 * authority here.
 */
function isTurnStart(record) {
  return record?.type === 'turn/start'
}

const files = walk(root)
  .map((f) => ({ f, mtime: statSync(f).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)
  .slice(0, maxFiles)

const rows = []
for (const { f } of files) {
  let turns = 0
  let requests = 0
  let promptTokens = 0
  for (const line of decode(f)) {
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (isTurnStart(record)) turns++
    const usage = record.data?.usage ?? record.usage
    if (!usage) continue
    requests++
    promptTokens += (Number(usage.inputTokens) || 0) + (Number(usage.cacheReadTokens) || 0)
  }
  if (requests === 0) continue
  rows.push({
    id: f.split(/[\\/]/).slice(-2, -1)[0],
    turns,
    requests,
    perTurn: turns ? requests / turns : undefined,
    avgContext: promptTokens / requests,
  })
}

rows.sort((a, b) => b.requests - a.requests)
console.log('session                  turns  requests  req/turn  avg context')
for (const r of rows.slice(0, 12)) {
  console.log(
    `${r.id.slice(0, 22).padEnd(24)}${String(r.turns).padStart(5)}${String(r.requests).padStart(10)}` +
    `${(r.perTurn === undefined ? 'n/a' : r.perTurn.toFixed(1)).padStart(10)}${Math.round(r.avgContext).toLocaleString().padStart(13)}`,
  )
}

const withTurns = rows.filter((r) => r.turns > 0)
if (withTurns.length > 0) {
  const totalReq = withTurns.reduce((n, r) => n + r.requests, 0)
  const totalTurns = withTurns.reduce((n, r) => n + r.turns, 0)
  const weighted = withTurns.reduce((n, r) => n + r.requests * r.avgContext, 0)
  console.log(`\nTOTAL sessions=${withTurns.length}  turns=${totalTurns}  requests=${totalReq}  requests/turn=${(totalReq / totalTurns).toFixed(1)}`)
  console.log(`prompt tokens in total: ${weighted.toLocaleString()}`)
  console.log('\nPrompt volume is roughly (average context) x (requests). Both factors are')
  console.log('reducible: fewer tool calls cuts requests, and keeping bulk text out of')
  console.log('context cuts the average.')
  console.log('\nNOTE: a request count also includes internal calls that no user turn')
  console.log('      triggered, so "req/turn" is a ratio to reason about, not a budget.')
}
