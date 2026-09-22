// Settle the question the rotation design depends on: is the free per-minute
// token allowance per MODEL or shared per ACCOUNT?
//
// Earlier attempts failed to answer it because 60 tiny requests spend almost no
// tokens (a few thousand against a 50,000 TPM ceiling). This one makes each
// request expensive on purpose:
//   - a large prompt (a few hundred tokens) so INPUT counts
//   - enable_thinking true so the model spends its whole output budget on
//     reasoning, which counts as OUTPUT tokens
// That makes ~1,000+ tokens per request, so ~50 requests can exhaust a minute's
// allowance. The models are free, so this costs money nothing.
//
// Usage (from the DSH profile directory):
//   node <this-repo>\test\test-quota-scope.mjs [requests]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseYaml } from '../tools/yaml-min.mjs'

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE, '.dsh')
const settings = parseYaml(readFileSync(join(dshHome, 'settings.yaml'), 'utf8'))
const creds = parseYaml(readFileSync(join(dshHome, '.credentials.yaml'), 'utf8'))
const route = settings['llm-pi-ai'].providers.siliconflow
const key = creds.refs[route.apiKeyEnv]
const base = route.baseURL.replace(/\/+$/, '')

const BURN = 'Qwen/Qwen2.5-7B-Instruct'          // cheapest/fastest to burn with
const OTHERS = ['Qwen/Qwen3-8B', 'THUDM/GLM-4-9B-0414', 'Qwen/Qwen3.5-4B']
const TOTAL = Number(process.argv[2] ?? 80)

const FILLER = Array.from({ length: 700 }, (_, i) =>
  `record ${i}: nominal telemetry sample for token accounting, no meaningful content.`).join('\n')

async function call(model, { big = false, think = false, maxTokens = 512 } = {}) {
  const body = {
    model,
    messages: [{ role: 'user', content: big ? `${FILLER}\n\nReply with one word: OK.` : 'Reply with one word: OK.' }],
    max_tokens: maxTokens,
    temperature: 0,
    stream: false,
    // Only the top-level spelling had any effect on SiliconFlow when measured.
    // Here it is set TRUE so the model burns its output budget on reasoning.
    enable_thinking: think,
  }
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    if (res.ok) {
      const j = await res.json()
      return { status: 200, inTok: j.usage?.prompt_tokens ?? 0, outTok: j.usage?.completion_tokens ?? 0 }
    }
    const t = await res.text().catch(() => '')
    let code = ''
    try { code = JSON.parse(t)?.code ?? '' } catch { /* not json */ }
    return { status: res.status, body: `${code} ${t.slice(0, 140)}` }
  } catch (error) {
    return { status: 0, body: error.message.slice(0, 120) }
  }
}

console.log(`burn target : ${BURN}`)
console.log(`each request: large prompt + 512 output budget + thinking ON\n`)

const t0 = Date.now()
let spent = 0
let ok = 0
let limited = 0
let firstLimit = null

// Sequential: we want to watch the allowance drain, not race it.
for (let i = 1; i <= TOTAL; i++) {
  const r = await call(BURN, { big: true, think: true })
  if (r.status === 200) {
    ok++
    spent += r.inTok + r.outTok
    if (i % 10 === 0) {
      console.log(`  #${String(i).padStart(3)}  spent ${spent.toLocaleString().padStart(8)} tok  ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    }
  } else if (r.status === 429) {
    limited++
    firstLimit = r.body
    console.log(`  #${i}  >>> HTTP 429 after ${spent.toLocaleString()} tokens in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    console.log(`      ${r.body}`)
    break
  } else {
    console.log(`  #${i}  unexpected HTTP ${r.status}: ${r.body}`)
    break
  }
}

console.log(`\nburn: ok=${ok} limited=${limited} tokens=${spent.toLocaleString()} wall=${((Date.now() - t0) / 1000).toFixed(0)}s`)

console.log('\nnow immediately probing the OTHER free models:')
let answered = 0
for (const m of OTHERS) {
  const r = await call(m, { maxTokens: 16 })
  const verdict = r.status === 200 ? `OK out=${r.outTok}` : `HTTP ${r.status} ${r.body ?? ''}`
  if (r.status === 200) answered++
  console.log(`  ${m.padEnd(30)} ${verdict}`)
}

console.log('')
if (limited > 0 && answered === OTHERS.length) {
  console.log('ANSWER: the allowance is PER MODEL. Exhausting one did not block the')
  console.log('        others, so rotating between free models during a 429 is valid.')
} else if (limited > 0 && answered < OTHERS.length) {
  console.log('ANSWER: the allowance is SHARED per account. Rotating cannot help --')
  console.log('        when one model is throttled the others are too.')
} else if (limited === 0) {
  console.log('ANSWER: could not exhaust the allowance with this many requests.')
  console.log('        Either the ceiling is higher than documented or it is counted')
  console.log(`        differently. ${TOTAL} requests spent ${spent.toLocaleString()} tokens.`)
  console.log('        Practical reading: the limit is hard to hit by accident, so')
  console.log('        rotation is a resilience feature rather than a capacity one.')
}
