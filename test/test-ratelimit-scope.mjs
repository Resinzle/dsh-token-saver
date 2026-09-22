// Test whether the free per-minute allowance is per MODEL or shared per ACCOUNT.
//
// Method: spend one model's quota as fast as possible, then immediately ask the
// other models for a token. If the others still answer, their allowances are
// separate. If they start returning 429, the allowance is shared.
//
// The models are free, so this costs nothing but a few thousand tokens of quota.
//
// Usage (from the DSH profile directory):
//   node <this-repo>\test\test-ratelimit-scope.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseYaml } from '../tools/yaml-min.mjs'

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE, '.dsh')
const settings = parseYaml(readFileSync(join(dshHome, 'settings.yaml'), 'utf8'))
const creds = parseYaml(readFileSync(join(dshHome, '.credentials.yaml'), 'utf8'))
const route = settings?.['llm-pi-ai']?.providers?.siliconflow
const key = (creds.refs ?? {})[route.apiKeyEnv]
const base = route.baseURL.replace(/\/+$/, '')
const ids = route.models.map((m) => m.id)

const BURN = ids[0]                 // the model whose quota we spend
const OTHERS = ids.slice(1)
const REQUESTS = Number(process.argv[2] ?? 40)

async function ask(model, maxTokens = 8) {
  const started = Date.now()
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        max_tokens: maxTokens,
        temperature: 0,
        stream: false,
        enable_thinking: false,
      }),
      signal: AbortSignal.timeout(60_000),
    })
    const ms = Date.now() - started
    if (res.ok) {
      const j = await res.json()
      return { status: 200, ms, out: j.usage?.completion_tokens ?? 0 }
    }
    const t = await res.text().catch(() => '')
    return { status: res.status, ms, body: t.slice(0, 160) }
  } catch (error) {
    return { status: 0, ms: Date.now() - started, body: error.message.slice(0, 120) }
  }
}

async function burn(model, n, concurrency = 8) {
  let ok = 0
  let limited = 0
  let other = 0
  let firstStatus = null
  let index = 0
  async function worker() {
    while (index < n) {
      const i = index++
      const r = await ask(model)
      if (firstStatus === null) firstStatus = r.status
      if (r.status === 200) ok++
      else if (r.status === 429) limited++
      else other++
      if (i % 10 === 9) process.stdout.write(`  ...${i + 1}/${n} (ok=${ok} 429=${limited} other=${other})\n`)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return { ok, limited, other, firstStatus }
}

console.log(`burning quota on: ${BURN}  (${REQUESTS} requests, 8 concurrent)`)
const burnResult = await burn(BURN, REQUESTS)
console.log(`  result: ok=${burnResult.ok} 429=${burnResult.limited} other=${burnResult.other}\n`)

console.log('immediately asking every OTHER model:')
let independent = 0
for (const m of OTHERS) {
  const r = await ask(m)
  const verdict = r.status === 200 ? 'OK' : `HTTP ${r.status}`
  if (r.status === 200) independent++
  console.log(`  ${m.padEnd(42)} ${verdict}  (${r.ms}ms)`)
}

console.log('')
console.log(`burn model hit 429: ${burnResult.limited > 0 ? 'yes' : 'no'}`)
console.log(`other models still answering: ${independent}/${OTHERS.length}`)
console.log('')
if (burnResult.limited > 0 && independent === OTHERS.length) {
  console.log('CONCLUSION: allowances are PER MODEL. One model being rate-limited does')
  console.log('            not block the others, so models can be rotated under load.')
} else if (burnResult.limited > 0 && independent < OTHERS.length) {
  console.log('CONCLUSION: allowances look SHARED per account. Exhausting one model')
  console.log('            blocked the others.')
} else {
  console.log('INCONCLUSIVE: the burn model never hit 429, so no allowance was')
  console.log('              exhausted. Treat the allowance as shared (the safe')
  console.log('              reading) until a harder test says otherwise.')
}
