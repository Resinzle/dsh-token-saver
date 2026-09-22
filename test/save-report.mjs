// 省 token 效果报表：读你自己的会话日志，算出真实花费与可省部分。
//
// 不调用任何 API，纯本地解析。用法：
//   node <this-repo>\test\save-report.mjs
//   node <this-repo>\test\save-report.mjs 20      (只看最近 20 个会话)
//
// 定价（deepseek-flash，每 1M token，非高峰）：
//   缓存命中 $0.003 / 未命中 $0.15 / 输出 $0.6
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const root = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'sessions')
  : 'C:\\Users\\\u543e\\.dsh\\sessions'
const maxFiles = Number(process.argv[2] ?? 40)

const PRICE = { hit: 0.003, miss: 0.15, output: 0.6 }
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SPILL_CAP = 12_000   // 已配置：超过此字节数的纯文本工具结果不再进入上下文
const OLD_CAP = 50_000     // 原配置

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
    try { for (const l of zstdDecompressSync(raw.subarray(offs[k], end)).toString('utf8').split('\n')) if (l.trim()) lines.push(l) } catch { /* 跳过坏帧 */ }
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

const files = walk(root).map((f) => ({ f, mtime: statSync(f).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime).slice(0, maxFiles)

const sessions = []

for (const { f } of files) {
  const lines = decode(f)
  // 先按顺序收集事件，才能算出"一个大结果进入后，后面还有多少次请求"
  const events = []
  for (const line of lines) {
    let r
    try { r = JSON.parse(line) } catch { continue }
    events.push(r)
  }

  const requestIdx = []
  for (let i = 0; i < events.length; i++) {
    const u = events[i].data?.usage ?? events[i].usage
    if (u) requestIdx.push({ i, uncached: Number(u.inputTokens) || 0, cached: Number(u.cacheReadTokens) || 0, output: Number(u.outputTokens) || 0 })
  }
  if (requestIdx.length === 0) continue
  const totalRequests = requestIdx.length

  // 统计会被 spill 的大结果，以及它之后还有多少次请求（= 会被重发的次数）
  let largeN = 0, largeChars = 0, replayChars = 0, oldLargeChars = 0
  let largeResultPositions = 0
  for (let i = 0; i < events.length; i++) {
    if (events[i].type !== 'tool/result') continue
    const n = textLen(events[i].data?.message?.content)
    if (n > OLD_CAP) oldLargeChars += n
    if (n > SPILL_CAP) {
      largeN++
      largeChars += n
      // 该结果之后发生的请求数
      const after = requestIdx.filter((r) => r.i > i).length
      if (after > 0) { replayChars += n * after; largeResultPositions += after }
    }
  }

  const uncached = requestIdx.reduce((a, r) => a + r.uncached, 0)
  const cached = requestIdx.reduce((a, r) => a + r.cached, 0)
  const output = requestIdx.reduce((a, r) => a + r.output, 0)
  const prompt = uncached + cached

  const cost = {
    hit: (cached / 1e6) * PRICE.hit,
    miss: (uncached / 1e6) * PRICE.miss,
    output: (output / 1e6) * PRICE.output,
  }
  const total = cost.hit + cost.miss + cost.output

  // 节省估算：以字符≈token/3 保守折算，只算"从缓存重放里省掉"的部分
  const savedTokens = Math.round(replayChars / 3)
  const savedHit = (savedTokens / 1e6) * PRICE.hit
  // 一次性代价：spill 之后首次请求要重算前缀（未命中价）——保守按大结果本身的量估
  const oneTimeCost = (Math.round(largeChars / 3) / 1e6) * PRICE.miss

  sessions.push({
    id: f.split(/[\\/]/).slice(-2, -1)[0],
    requests: totalRequests,
    prompt, uncached, cached, output,
    cost, total,
    largeN, largeChars, savedTokens, savedHit, oneTimeCost, replayChars,
    hitRate: prompt ? (cached / prompt) * 100 : 0,
  })
}

if (sessions.length === 0) { console.log('没找到可解析的会话日志。'); process.exit(0) }

sessions.sort((a, b) => b.total - a.total)

const money = (n) => '$' + n.toFixed(4)
const num = (n) => n.toLocaleString()

console.log('=== 每个会话的真实花费（按花费排序）===')
console.log('会话                     请求数      花费     缓存命中率   大块工具输出   其中可省')
for (const s of sessions.slice(0, 12)) {
  console.log(
    `${s.id.slice(0, 20).padEnd(22)}${String(s.requests).padStart(6)}${money(s.total).padStart(11)}` +
    `${(s.hitRate.toFixed(1) + '%').padStart(11)}${String(s.largeN).padStart(13)}${money(s.savedHit).padStart(11)}`,
  )
}

const T = sessions.reduce((a, s) => ({
  total: a.total + s.total,
  hit: a.hit + s.cost.hit,
  miss: a.miss + s.cost.miss,
  output: a.output + s.cost.output,
  prompt: a.prompt + s.prompt,
  uncached: a.uncached + s.uncached,
  cached: a.cached + s.cached,
  out: a.out + s.output,
  saved: a.saved + s.savedHit,
  oneTime: a.oneTime + s.oneTimeCost,
  largeN: a.largeN + s.largeN,
  largeChars: a.largeChars + s.largeChars,
  requests: a.requests + s.requests,
  savedTokens: a.savedTokens + s.savedTokens,
  replayChars: a.replayChars + (s.replayChars ?? 0),
}), { total: 0, hit: 0, miss: 0, output: 0, prompt: 0, uncached: 0, cached: 0, out: 0, saved: 0, oneTime: 0, largeN: 0, largeChars: 0, requests: 0, savedTokens: 0, replayChars: 0 })

console.log('\n=== 账单构成（全部会话合计）===')
console.log(`  缓存输入（命中）   ${num(T.cached).padStart(12)} tok   ${money(T.hit).padStart(9)}   ${(T.hit / T.total * 100).toFixed(1)}%`)
console.log(`  未缓存输入（未命中）${num(T.uncached).padStart(12)} tok   ${money(T.miss).padStart(9)}   ${(T.miss / T.total * 100).toFixed(1)}%`)
console.log(`  输出               ${num(T.out).padStart(12)} tok   ${money(T.output).padStart(9)}   ${(T.output / T.total * 100).toFixed(1)}%`)
console.log(`  ${'合计'.padEnd(18)}${num(T.prompt + T.out).padStart(12)} tok   ${money(T.total).padStart(9)}`)
console.log(`  请求总数 ${num(T.requests)}   缓存命中率 ${(T.cached / T.prompt * 100).toFixed(1)}%`)

console.log('\n=== 这次改动的效果（超过 12KB 的工具输出不再进入上下文）===')
console.log(`  受影响的大块工具输出: ${T.largeN} 个，共 ${(T.largeChars / 1e6).toFixed(2)}M 字符`)
console.log(`  它们此后被重复重发的量: 约 ${num(Math.round(T.savedTokens * 3))} 字符 (≈${num(T.savedTokens)} tok)`)
console.log(`  预计节省（缓存重放部分）: ${money(T.saved)}`)
console.log(`  一次性代价（重建前缀） : ${money(T.oneTime)}`)
const net = T.saved - T.oneTime
console.log(`  预计净节省             : ${money(net)}   （占账单 ${(net / T.total * 100).toFixed(1)}%）`)
console.log('\n  说明：这是估算，不是账单原文。依据是"大结果在上下文里被重发的次数"')
console.log('  乘以缓存命中价。改动的价值在于让这部分内容**根本不再被重发**。')
console.log('  真实效果会在改动之后的会话里体现——过几天再跑一次这个脚本对比。')
