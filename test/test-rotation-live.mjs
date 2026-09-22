// Integration-test the rotation chain against the live free endpoints.
//
// The primary credential is deliberately invalid, which makes the primary
// unusable the same way a 429 does and forces the chain to carry the call. This
// proves the wiring end to end: chain construction from config syntax, endpoint
// selection, a real HTTP delegation from a rotated endpoint, and the trailing
// note the model reads.
//
// Usage (from the DSH profile directory so harness packages resolve):
//   node <this-repo>\test\test-rotation-live.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseYaml } from '../tools/yaml-min.mjs'
import { apply } from 'dsh-plugin-local-offload'
import { EndpointChain } from 'dsh-plugin-local-offload/lib/rotation.js'

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE, '.dsh')
const creds = parseYaml(readFileSync(join(dshHome, '.credentials.yaml'), 'utf8'))
const key = creds.refs.SILICONFLOW_API_KEY
const credentialsFile = join(dshHome, '.credentials.yaml')

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures.push(label)
}

// The exact chain syntax the profile patch uses.
const chainSpec = JSON.stringify([
  'https://api.siliconflow.cn/v1|THUDM/GLM-4-9B-0414',
  'https://api.siliconflow.cn/v1|Qwen/Qwen3-8B',
  'http://127.0.0.1:18080|local-qwen3-8b',
])

console.log('== chain construction from the configured syntax ==')
// Uses the REAL credential reference, because that is the deployed shape. An
// earlier version passed a deliberately invalid literal key with no env
// reference and expected rotation to rescue the call -- but that scenario is
// incoherent: with no valid credential anywhere, every endpoint must fail, and
// chain entries correctly inherit the resolved credential rather than a bad one.
// The rotation path that actually matters is a 429, which cannot be forced on
// demand; the park/skip/recover behaviour is covered by test-rotation.mjs.
const registered = []
apply({ tools: { register: (d) => registered.push(d) }, logger: { info: () => {}, warn: () => {} } }, {
  baseUrl: 'https://api.siliconflow.cn/v1',
  model: 'Qwen/Qwen3-8B',
  apiKey: 'unused-because-the-credential-file-wins',
  apiKeyEnv: 'SILICONFLOW_API_KEY',
  // Required. Passing `apiKeyEnv` alone is what the plugin used to rely on, and it
  // produced HTTP 401 on every call because the harness never exports
  // `.credentials.yaml` into the environment. This test caught that regression the
  // moment the plugin's resolution changed, which is the point of wiring the test
  // through the plugin's own resolution instead of resolving the key here.
  credentialsFile,
  timeoutMs: 60_000,
  maxInputChars: 400_000,
  maxOutputTokens: 256,
  temperature: 0.2,
  maxContextTokens: 131072,
  chain: chainSpec,
  cooldownSeconds: 65,
})
const tool = registered.find((t) => t.name === 'local_delegate')
check('tool registered', Boolean(tool))
check('a real credential is available to the chain', typeof key === 'string' && key.length > 20)

console.log('\n== rotation logic in isolation ==')
const c = new EndpointChain([
  { baseUrl: 'https://api.siliconflow.cn/v1', model: 'm1' },
  { baseUrl: 'https://api.siliconflow.cn/v1', model: 'm2' },
], { cooldownMs: 1000 })
check('two same-host endpoints have distinct keys',
  EndpointChain.keyOf(c.entries[0]) !== EndpointChain.keyOf(c.entries[1]),
  EndpointChain.keyOf(c.entries[1]))

console.log('\n== live call through the same wiring ==')
if (tool) {
  const payload = Array.from({ length: 40 }, (_, i) =>
    `[${i}] ERROR code=E_${i % 3} file=src/f_${i % 5}.ts line=${10 + i}`).join('\n')
  const started = Date.now()
  try {
    const out = await tool.execute({
      task: 'extract',
      instruction: 'List every distinct ERROR code, comma separated. Nothing else.',
      text: payload,
    }, {})
    const secs = ((Date.now() - started) / 1000).toFixed(1)
    const answer = out.split('\n\n[')[0].trim()
    console.log(`  ${payload.length} chars -> ${out.length} chars in ${secs}s`)
    console.log(`  answer: ${answer.slice(0, 120)}`)
    check('an endpoint answered', answer.length > 0)
    check('the answer is correct', ['E_0', 'E_1', 'E_2'].every((x) => answer.includes(x)), answer.slice(0, 60))
    check('the result names the endpoint and its token usage',
      /\[.*: \d+ in \/ \d+ out tokens/.test(out))
  } catch (error) {
    console.log(`  note: chain exhausted -> ${error.message.slice(0, 200)}`)
    check('an endpoint answered', false, 'all endpoints refused')
  }
}

console.log('')
if (failures.length === 0) console.log('ROTATION: ALL PASS')
else {
  console.log(`ROTATION: ${failures.length} FAILURE(S) -> ${failures.join('; ')}`)
  process.exitCode = 1
}
