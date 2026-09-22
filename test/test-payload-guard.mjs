// Verify the payload guard cannot overrun the local server's context window.
//
// The case that motivated it: a 30,000-character Chinese payload killed a running
// llama-server, surfacing only as "fetch failed". The guard sizes the payload from
// the server's real n_ctx instead of a character count, because Chinese costs
// roughly one token per character and English about one per four -- no single
// character cap bounds both.
//
// This test targets the LOCAL endpoint explicitly rather than whatever the profile
// happens to name. It previously spread its own `client` object into the plugin
// config but left `apiKeyEnv` unset while the surrounding environment supplied a
// remote base URL, so it asserted local-server behaviour against a hosted endpoint
// with a 128K window. Nothing truncated, and the test reported a defect that did
// not exist. Explicit config removes that ambiguity.
//
// Usage:
//   node test/test-payload-guard.mjs [baseUrl]
import { apply } from 'dsh-plugin-local-offload'
import { health, contextWindow } from 'dsh-plugin-local-offload/lib/http.js'

const baseUrl = process.argv[2] ?? process.env.LOCAL_AI_URL ?? 'http://127.0.0.1:18080'
const client = { baseUrl, model: 'local-qwen3-8b', apiKey: 'local-no-key', timeoutMs: 600_000 }

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures.push(label)
}

// The guard can only be exercised against a server that reports a window. With no
// server listening there is nothing to protect, so this skips rather than fails:
// the local server is deliberately not auto-started, which makes absence normal.
const nCtx = await contextWindow(client, AbortSignal.timeout(5000))
console.log(`local endpoint ${baseUrl}`)
console.log(`server n_ctx = ${nCtx}`)
if (!Number.isFinite(nCtx) || nCtx <= 0) {
  console.log('')
  console.log(`SKIP  no llama-server is answering at ${baseUrl}, so there is no context window to guard.`)
  console.log('      Start it with: powershell -File F:\\bonsai\\start-local-ai.ps1  then re-run.')
  process.exit(0)
}

const registered = []
apply(
  { tools: { register: (d) => registered.push(d) }, logger: { info: () => {}, warn: () => {} } },
  {
    baseUrl,
    model: client.model,
    apiKey: client.apiKey,
    // Explicit, so no ambient credential can turn this into a hosted call.
    apiKeyEnv: '',
    credentialsFile: '',
    maxInputChars: 400_000,
    maxOutputTokens: 1024,
    temperature: 0.2,
    maxContextTokens: 0,
    extraBody: '',
    chain: '',
    chainApiKeyEnv: '',
    cooldownSeconds: 65,
    timeoutMs: client.timeoutMs,
  },
)
const tool = registered[0]
check('the tool registered', Boolean(tool))

const zhSentence = '\u8FD9\u662F\u4E00\u6BB5\u7528\u4E8E\u6D4B\u8BD5\u7684\u4E2D\u6587\u6587\u672C\uFF0C\u5305\u542B\u6280\u672F\u7EC6\u8282\u548C\u9519\u8BEF\u63CF\u8FF0\u3002'
const enSentence = 'This is a test sentence used to measure payload handling, containing technical detail and error descriptions. '

/**
 * The truncation notice's current wording.
 *
 * An earlier version of this test matched `[warn: payload cut to ~N of M allowed
 * tokens`, which was the message at the time. The wording changed to report what
 * was dropped rather than comparing the kept size against the budget, and this
 * regex was not updated with it -- so two checks here failed for a wording change
 * rather than a behaviour change. Matching the stable prefix and parsing the
 * numbers from their labels keeps the assertions tied to meaning.
 */
const WARN_RE = /\[warn: payload truncated to fit (\d+) tokens; (\d+) of (\d+) characters dropped \((\d+) tokens kept/
const WARN_PREFIX = '[warn: payload truncat'

async function probe(label, payload, task = 'summarize') {
  const t0 = Date.now()
  try {
    const out = await tool.execute({ task, instruction: '\u7528\u4E00\u53E5\u8BDD\u6982\u62EC\u3002', text: payload }, {})
    const secs = (Date.now() - t0) / 1000
    const warned = out.includes(WARN_PREFIX)
    const m = WARN_RE.exec(out)
    console.log(`  ${label}: ${payload.length} chars -> ${secs.toFixed(1)}s, warned=${warned}${m ? ` (budget ${m[1]}, kept ${m[4]}, dropped ${m[2]}/${m[3]})` : ''}`)
    return { ok: true, warned, secs, raw: out, match: m }
  } catch (error) {
    console.log(`  ${label}: FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${error.message.slice(0, 140)}`)
    return { ok: false, warned: false }
  }
}

console.log('\n-- payloads within budget (must succeed, no warning) --')
const small = await probe('en  3K chars', enSentence.repeat(30).slice(0, 3000))
check('English 3K succeeds without truncation', small.ok && !small.warned)
const zhSmall = await probe('zh  3K chars', zhSentence.repeat(75).slice(0, 3000))
check('Chinese 3K succeeds without truncation', zhSmall.ok && !zhSmall.warned)

console.log('\n-- payload that previously killed the server (must truncate, not crash) --')
const huge = await probe('zh 30K chars', zhSentence.repeat(750).slice(0, 30000))
check('Chinese 30K is handled by truncation (no crash)', huge.ok, huge.ok ? '' : 'call failed')
check('Chinese 30K reports the cut', huge.warned, huge.warned ? '' : `window ${nCtx} was large enough that no cut was needed`)

// A truncation that keeps almost nothing is worse than refusing the call: it
// returns a confident answer about a payload that was thrown away. The notice
// names the kept size and the budget it was kept within.
if (huge.match) {
  const budget = Number(huge.match[1])
  const kept = Number(huge.match[4])
  check('the kept slice uses most of the budget', kept >= budget * 0.5, `${kept}/${budget} tokens`)
} else {
  check('the kept slice uses most of the budget', false, 'no numbers in the notice')
}

console.log('\n-- server must still be alive afterwards --')
const after = await health(client, AbortSignal.timeout(5000))
check('server still healthy', after.ok, after.detail)

console.log('')
if (failures.length === 0) console.log('PAYLOAD GUARD: ALL PASS')
else { console.log(`PAYLOAD GUARD: ${failures.length} FAILURE(S) -> ${failures.join('; ')}`); process.exitCode = 1 }
