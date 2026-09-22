// Verify the SiliconFlow delegation path end to end.
//
// Reads the key the same way the plugin does (env, then the credential ref the
// DSH route names), then drives the plugin's own client + tool against
// SiliconFlow. One small call, so it costs no meaningful quota.
//
// Run from the DSH profile directory:
//   cd $DSH_HOME\profiles\web ; node <this-repo>\test\test-siliconflow.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseYaml } from '../tools/yaml-min.mjs'
import { apply } from 'dsh-plugin-local-offload'
import { complete, health, isLocalEndpoint } from 'dsh-plugin-local-offload/lib/http.js'

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE, '.dsh')
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures.push(label)
}

// 1. The credential the DSH route names actually resolves.
const creds = parseYaml(readFileSync(join(dshHome, '.credentials.yaml'), 'utf8'))
const key = (creds.refs ?? {}).SILICONFLOW_API_KEY
console.log('-- credential --')
check('SILICONFLOW_API_KEY is present', typeof key === 'string' && key.length > 20, key ? `${key.length} chars` : 'missing')
check('it is not the placeholder', typeof key === 'string' && !key.includes('REPLACE_WITH_YOUR'))

// 2. The live settings file points the title call at this route.
const settings = parseYaml(readFileSync(join(dshHome, 'settings.yaml'), 'utf8'))
const route = settings?.['llm-pi-ai']?.providers?.siliconflow
console.log('\n-- settings.yaml --')
check('a siliconflow provider route exists', Boolean(route))
check('it names the documented endpoint', route?.baseURL === 'https://api.siliconflow.cn/v1', String(route?.baseURL))
check('it references this credential', route?.apiKeyEnv === 'SILICONFLOW_API_KEY', String(route?.apiKeyEnv))
check('it declares Qwen/Qwen3-8B', (route?.models ?? []).some((m) => m.id === 'Qwen/Qwen3-8B'))
check('it declares a 128K window', (route?.models ?? []).some((m) => m.id === 'Qwen/Qwen3-8B' && m.contextWindow === 131072))

// 3. Endpoint classification: this must NOT be treated as local.
console.log('\n-- endpoint classification --')
check('the hosted endpoint is not treated as local', isLocalEndpoint('https://api.siliconflow.cn/v1') === false)
check('the llama.cpp endpoint is still treated as local', isLocalEndpoint('http://127.0.0.1:18080') === true)

// 4. A real delegation through the plugin's own tool.
console.log('\n-- live delegation through local_delegate --')
const registered = []
apply(
  { tools: { register: (d) => registered.push(d) }, logger: { info: () => {}, warn: () => {} } },
  {
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen3-8B',
    apiKey: 'unused',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    // Required alongside `apiKeyEnv`: the harness keeps saved keys in
    // `.credentials.yaml` and never exports them, so a plugin that reads only the
    // environment sends this placeholder and gets HTTP 401. See
    // docs/troubleshooting.md.
    credentialsFile: join(dshHome, '.credentials.yaml'),
    timeoutMs: 120000,
    maxInputChars: 400000,
    maxOutputTokens: 512,
    temperature: 0.2,
    maxContextTokens: 131072,
  },
)
const tool = registered.find((t) => t.name === 'local_delegate')
check('the tool registered', Boolean(tool))

if (tool && key) {
  const payload = Array.from({ length: 60 }, (_, i) =>
    `[${i}] ERROR code=E_${i % 4} file=src/module_${i % 8}.ts line=${100 + i} detail=handshake timeout sid_${i * 9}`,
  ).join('\n')
  const started = Date.now()
  try {
    const out = await tool.execute(
      { task: 'extract', instruction: 'List the distinct ERROR codes and count the lines for src/module_3.ts.', text: payload },
      {},
    )
    const secs = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`  payload ${payload.length} chars -> ${out.length} chars in ${secs}s`)
    console.log(`  answer: ${out.replace(/\n/g, ' | ').slice(0, 200)}`)
    check('the hosted model returned an answer', out.length > 0)
    check('it found the distinct codes', /E_0/.test(out) && /E_3/.test(out))
    check('it reported token usage', /tokens/.test(out))
  } catch (error) {
    check('live delegation succeeded', false, error.message.slice(0, 220))
  }
} else {
  check('live delegation ran', false, 'tool or key missing')
}

console.log('')
if (failures.length === 0) console.log('SILICONFLOW: ALL PASS')
else {
  console.log(`SILICONFLOW: ${failures.length} FAILURE(S) -> ${failures.join('; ')}`)
  process.exitCode = 1
}
