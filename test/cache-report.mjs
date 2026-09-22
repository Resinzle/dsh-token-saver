// Measure prompt-cache effectiveness from DSH session logs.
//
// The paid agent loop resends the whole transcript every step, so the bill is
// dominated by input tokens. DeepSeek bills cached input at a fraction of
// uncached input, which makes the cache hit rate the single most important
// number for cost -- and it decides whether context compression is even the
// right lever (compacting rewrites history and can invalidate the cache).
//
// Usage: node cache-report.mjs [sessionsRoot] [maxFiles]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const root = process.argv[2] ?? 'C:\\Users\\\u543e\\.dsh\\sessions'
const maxFiles = Number(process.argv[3] ?? 60)
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

function decode(raw) {
  const offs = []
  let i = 0
  while (i < raw.length - 4) {
    const idx = raw.indexOf(MAGIC, i)
    if (idx === -1) break
    offs.push(idx)
    i = idx + 4
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

const files = walk(root).map((f) => ({ f, mtime: statSync(f).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime).slice(0, maxFiles)

let grandInput = 0
let grandCached = 0
let grandOutput = 0
let grandCalls = 0
const perSession = []

for (const { f } of files) {
  const lines = decode(readFileSync(f))
  let input = 0, cached = 0, output = 0, calls = 0
  let compactions = 0
  let usageShapes = new Set()
  for (const line of lines) {
    let r
    try { r = JSON.parse(line) } catch { continue }
    if (r.type === 'compaction/start') compactions++
    const u = r.data?.usage ?? r.usage
    if (!u) continue
    // The adapter reports provider usage; cached tokens may sit at several
    // spellings depending on the wire format.
    const details = u.prompt_tokens_details ?? u.promptTokensDetails ?? {}
    // Field spellings actually observed in DSH session logs:
    //   inputTokens, outputTokens, totalTokens, cacheReadTokens, reasoningTokens
    // `inputTokens` is the UNCACHED portion; `cacheReadTokens` is the reused
    // prefix. The real prompt volume is their sum, which is why dividing
    // cached by inputTokens alone produces nonsense above 100%.
    const c = details.cached_tokens ?? details.cachedTokens ?? u.cacheReadTokens ?? u.cachedInputTokens ?? u.cacheReadInputTokens ?? 0
    const i = u.inputTokens ?? u.prompt_tokens ?? u.promptTokens ?? 0
    const o = u.outputTokens ?? u.completion_tokens ?? u.output_tokens ?? 0
    if (i === 0 && o === 0 && !c) continue
    usageShapes.add(JSON.stringify(Object.keys(u)))
    input += i
    cached += Number(c) || 0
    output += o
    calls++
  }
  if (calls === 0) continue
  perSession.push({ id: f.split(/[\\/]/).slice(-2, -1)[0], input, cached, output, calls, compactions })
  grandInput += input
  grandCached += cached
  grandOutput += output
  grandCalls += calls
}

const grandPrompt = grandInput + grandCached
perSession.sort((a, b) => (b.input + b.cached) - (a.input + a.cached))
console.log('session                  calls   prompt tok   cached tok   hit%   out tok  compact')
for (const s of perSession.slice(0, 12)) {
  const prompt = s.input + s.cached
  const hit = prompt ? ((s.cached / prompt) * 100).toFixed(1) : '0.0'
  console.log(
    `${s.id.slice(0, 22).padEnd(24)}${String(s.calls).padStart(5)}${String(prompt).padStart(13)}` +
    `${String(s.cached).padStart(13)}${hit.padStart(7)}${String(s.output).padStart(9)}${String(s.compactions).padStart(9)}`,
  )
}

const hitRate = grandPrompt ? (grandCached / grandPrompt) * 100 : 0
console.log(`\nTOTAL calls=${grandCalls}  prompt=${grandPrompt.toLocaleString()}  cached=${grandCached.toLocaleString()}  uncached=${grandInput.toLocaleString()}  output=${grandOutput.toLocaleString()}`)
console.log(`cache hit rate: ${hitRate.toFixed(1)}%  (cached / total prompt tokens)`)
console.log(`the paid-API bill scales with the UNCACHED column: ${grandInput.toLocaleString()} tokens`)
if (grandCached === 0) {
  console.log('\nNOTE: no cached-token field found in any usage record, so prompt caching')
  console.log('      may be unused or unmeasured.')
} else if (hitRate > 80) {
  console.log('\nThis is a high hit rate. The dominant lever is protecting the cached')
  console.log('prefix, NOT compacting more aggressively: rewriting history invalidates')
  console.log('the cache from the rewrite point onward.')
}
