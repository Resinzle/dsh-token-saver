// Prefill/generation scaling probe for local llama.cpp servers.
// Usage: node bench.mjs <baseUrl> <model> <targetTokens...>
const baseUrl = (process.argv[2] ?? 'http://127.0.0.1:18080').replace(/\/+$/, '')
const model = process.argv[3] ?? 'local-qwen3-8b'
const targets = process.argv.slice(4).map(Number)
if (targets.length === 0) targets.push(2000, 4000, 8000, 16000)

const words = ['config', 'handler', 'session', 'request', 'payload', 'buffer', 'index', 'token', 'worker', 'stream']
function makePayload(approxTokens) {
  // ~4 chars per token for this word soup; aim slightly low then trim to target chars.
  const chars = approxTokens * 4
  const parts = []
  let len = 0
  let i = 0
  while (len < chars) {
    const line = `[${i}] ${words[i % words.length]}_${i} = resolve(${words[(i + 3) % words.length]}_${i % 977}, ${i * 31})\n`
    parts.push(line)
    len += line.length
    i++
  }
  return parts.join('')
}

async function one(target) {
  const payload = makePayload(target)
  const body = {
    model,
    messages: [
      { role: 'system', content: 'You are a mechanical text-processing backend. Output the digest only.' },
      { role: 'user', content: `INSTRUCTION:\nSummarize in one sentence.\n\nPAYLOAD:\n${payload}` },
    ],
    max_tokens: 96,
    temperature: 0.2,
    stream: false,
    // Reuse of an identical prefix is served from the server's slot cache and
    // would report a fantasy prefill rate, so force a genuine cold pass.
    cache_prompt: false,
    chat_template_kwargs: { enable_thinking: false },
  }
  const started = Date.now()
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
      body: JSON.stringify(body),
    })
    const elapsed = (Date.now() - started) / 1000
    if (!res.ok) {
      const t = await res.text()
      console.log(`  target=${target}  HTTP ${res.status}  ${t.slice(0, 160)}`)
      return
    }
    const json = await res.json()
    const u = json.usage ?? {}
    const pt = u.prompt_tokens ?? 0
    const ct = u.completion_tokens ?? 0
    const prefillRate = pt / Math.max(elapsed - ct / 40, 0.001)
    console.log(`  target=${String(target).padStart(6)}  prompt=${String(pt).padStart(6)} tok  wall=${elapsed.toFixed(1).padStart(7)}s  ~${prefillRate.toFixed(0).padStart(4)} prefill tok/s  out=${ct}`)
  } catch (e) {
    console.log(`  target=${target}  FAILED: ${e.message}`)
  }
}

console.log(`benchmarking ${model} at ${baseUrl}`)
for (const t of targets) await one(t)
