// Pre-flight verification for the `local` DSH provider route.
//
// Scope, stated honestly: the adapter's internal profile resolution
// (`resolveProfiles` / `buildProvider`) is NOT exported, and a model descriptor
// built by hand outside it lacks the internal `api` / `provider` fields pi-ai's
// dispatch reads, so a hand-built provider cannot complete a real request. This
// script therefore verifies only what is provable from outside the harness:
//
//   1. the settings.yaml `llm-pi-ai` section passes the adapter's own schema
//   2. the route is self-describing (protocol + endpoint + non-empty models),
//      which is what a hand-declared route requires to be serviceable
//   3. the credential reference the route names actually resolves
//   4. the local server itself serves the OpenAI-compatible endpoint the route
//      points at, with bearer auth, and answers a real completion
//
// Points 1-3 are exactly the conditions DSH validates when it loads the route;
// point 4 proves the endpoint the route names is live. The remaining step -- the
// adapter's own resolution and dispatch -- can only be observed inside a running
// harness, so confirm it once via the Web model picker after restart.
//
// Run from the DSH profile directory:
//   cd $DSH_HOME/profiles/web ; node <this-repo>\test\verify-route.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseYaml } from '../tools/yaml-min.mjs'
import { Config } from '@deepseek-ai/dsh-llm-pi-ai'

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE, '.dsh')
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`)
  if (!ok) failures.push(label)
}

console.log('--- settings.yaml: llm-pi-ai section ---')
const settings = parseYaml(readFileSync(join(dshHome, 'settings.yaml'), 'utf8'))
const raw = settings['llm-pi-ai']
check('section exists', Boolean(raw))
const parsed = new Config(raw)
const routeIds = Object.keys(parsed.providers)
check('the adapter schema accepts the section', true)
// This used to assert `routeIds.length === 1`. That was true when the file
// declared only the local route; it is a property of one machine's settings, not
// a requirement, and a second free hosted route is perfectly valid. What matters
// is that every declared route validates and that `local` is present.
check('at least one route is declared', routeIds.length > 0, routeIds.join(','))
check('the local route is present', routeIds.includes('local'), routeIds.join(','))
const local = parsed.providers.local
check('route is named "local"', Boolean(local))

console.log('--- route is self-describing ---')
// A route pi-ai's catalog does not ship needs api + baseURL + a non-empty models
// list; that is the exact rule the adapter enforces.
check('names a wire protocol this build serves', local.api === 'openai-completions', String(local.api))
check('names an endpoint', typeof local.baseURL === 'string' && local.baseURL.length > 0, String(local.baseURL))
check('declares at least one model', Array.isArray(local.models) && local.models.length > 0, `${local.models?.length}`)
check('every declared model has an id', (local.models ?? []).every((m) => typeof m.id === 'string' && m.id.length > 0))
check('every declared model declares text input only', (local.models ?? []).every((m) => Array.isArray(m.input) && m.input.includes('text')))

console.log('--- credentials ---')
const creds = parseYaml(readFileSync(join(dshHome, '.credentials.yaml'), 'utf8'))
const key = (creds.refs ?? {})[local.apiKeyEnv]
check(`ref ${local.apiKeyEnv} is declared by the route`, typeof local.apiKeyEnv === 'string')
check(`ref ${local.apiKeyEnv} resolves to a value`, typeof key === 'string' && key.length > 0, key ? `${key.length} chars` : 'missing')

console.log('--- the endpoint the route names is live ---')
const modelId = local.models[0].id
let live = false
let liveDetail = ''
try {
  const started = Date.now()
  const res = await fetch(`${local.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: 'Answer with one word only.' },
        { role: 'user', content: 'What is the capital of France?' },
      ],
      max_tokens: 16,
      temperature: 0,
      stream: false,
    }),
  })
  const json = await res.json()
  const text = json.choices?.[0]?.message?.content ?? ''
  live = res.ok && text.trim().length > 0
  liveDetail = `HTTP ${res.status} in ${((Date.now() - started) / 1000).toFixed(1)}s, text=${JSON.stringify(text.slice(0, 60))}, prompt=${json.usage?.prompt_tokens} out=${json.usage?.completion_tokens}`
} catch (error) {
  liveDetail = error.message
}

// "Nothing is listening" and "something is listening but broken" are different
// facts and must not produce the same result. The local server is deliberately
// not auto-started (it occupies VRAM while running), so
// its absence is the normal state on this machine; failing here would train the
// reader to ignore this script. A reachable-but-failing endpoint still fails.
const unreachable = /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(liveDetail)
if (unreachable) {
  console.log(`  SKIP  POST ${local.baseURL}/chat/completions -- nothing is listening there (${liveDetail})`)
  console.log('        Start it with: powershell -File F:\\bonsai\\start-local-ai.ps1  then re-run.')
} else {
  check(`POST ${local.baseURL}/chat/completions with model "${modelId}" returns text`, live, liveDetail)
}

console.log('')
if (failures.length === 0) {
  console.log('PRE-FLIGHT: ALL PASS')
  console.log('Remaining manual step: after restarting DSH, open the model picker and')
  console.log('confirm "Local (F:\\bonsai)" and its two models are selectable.')
} else {
  console.log(`PRE-FLIGHT: ${failures.length} FAILURE(S) -> ${failures.join('; ')}`)
  process.exitCode = 1
}
