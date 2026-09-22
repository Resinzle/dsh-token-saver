// Probe every configured free SiliconFlow chat model with one minimal request.
//
// Purpose: confirm each model id actually answers on this account, and record
// its latency and that thinking can be suppressed. The prompts are one system
// line plus one word, so the whole sweep costs a few hundred tokens.
//
// Run from the DSH profile directory:
//   cd $DSH_HOME\profiles\web ; node <this-repo>\test\probe-models.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseYaml } from '../tools/yaml-min.mjs'

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE, '.dsh')
const settings = parseYaml(readFileSync(join(dshHome, 'settings.yaml'), 'utf8'))
const creds = parseYaml(readFileSync(join(dshHome, '.credentials.yaml'), 'utf8'))
const route = settings?.['llm-pi-ai']?.providers?.siliconflow
const key = (creds.refs ?? {})[route.apiKeyEnv]

const base = route.baseURL.replace(/\/+$/, '')
console.log(`endpoint: ${base}`)
console.log(`models configured: ${route.models.length}\n`)

const rows = []
for (const m of route.models) {
  const body = {
    model: m.id,
    messages: [
      { role: 'system', content: 'Answer with exactly one word.' },
      { role: 'user', content: 'Say READY.' },
    ],
    max_tokens: 32,
    temperature: 0,
    stream: false,
    // Only the top-level spelling worked on SiliconFlow when measured.
    enable_thinking: false,
  }
  const started = Date.now()
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    })
    const secs = ((Date.now() - started) / 1000).toFixed(1)
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      rows.push({ id: m.id, ok: false, secs, note: `HTTP ${res.status} ${t.slice(0, 90)}` })
      continue
    }
    const json = await res.json()
    const msg = json.choices?.[0]?.message ?? {}
    const text = typeof msg.content === 'string' ? msg.content : ''
    const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : ''
    rows.push({
      id: m.id,
      ok: text.trim().length > 0,
      secs,
      note: `out=${json.usage?.completion_tokens} thinkField=${reasoning.length > 0} text=${JSON.stringify(text.trim().slice(0, 24))}`,
    })
  } catch (error) {
    rows.push({ id: m.id, ok: false, secs: ((Date.now() - started) / 1000).toFixed(1), note: error.message.slice(0, 90) })
  }
}

console.log('model'.padEnd(42) + 'ok'.padEnd(6) + 'secs'.padEnd(8) + 'detail')
for (const r of rows) {
  console.log(`${r.id.padEnd(42)}${(r.ok ? 'YES' : 'NO').padEnd(6)}${String(r.secs).padEnd(8)}${r.note}`)
}

const good = rows.filter((r) => r.ok)
console.log(`\n${good.length}/${rows.length} answered.`)
console.log('\nNote: this sweep issues one call per model back to back, which is how a')
console.log('shared-allowance hypothesis would show itself -- if the allowance were')
console.log('per account and already spent, later models would start returning 429.')
console.log('All of them answering in one burst is weak evidence that the limits are')
console.log('per model, not conclusive (this burst is far below 50,000 tokens).')
