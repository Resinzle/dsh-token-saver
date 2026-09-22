// Verify the plugin registers and executes without a running harness.
// A stub ctx captures the registered tool and calls it directly, so this proves
// the defineTool contract (parameters, output render, execute) is satisfied.
import { apply, Config, name, inject } from '../lib/index.js'
import { health } from '../lib/http.js'

const registered = []
const ctx = {
  tools: { register: (def) => registered.push(def) },
  logger: { info: (...a) => console.log('  [plugin log]', ...a) },
}

const config = {
  baseUrl: process.env.LOCAL_AI_URL ?? 'http://127.0.0.1:18080',
  model: 'local-qwen3-8b',
  apiKey: 'local-no-key',
  timeoutMs: 600_000,
  maxInputChars: 120_000,
  maxOutputTokens: 512,
  temperature: 0.2,
}

console.log(`plugin name=${name} inject=${JSON.stringify(inject)}`)
apply(ctx, config)
console.log(`registered tools: ${registered.map((t) => t.name).join(', ')}`)

const tool = registered.find((t) => t.name === 'local_delegate')
if (!tool) throw new Error('local_delegate was not registered')

// Contract checks a harness would also enforce.
//
// The shape is `parameters: { type: 'object', properties: {...}, required: [...] }`
// -- verified by dumping what `defineTool` actually produces, not assumed. Two
// earlier versions of these assertions were wrong in different ways
// (`parameters.task.required`, then `parameters.task`), so this file threw before
// reaching them and had never run to completion.
const problems = []
const properties = tool.parameters?.properties ?? {}
const required = Array.isArray(tool.parameters?.required) ? tool.parameters.required : []
if (typeof tool.description !== 'string' || tool.description.length < 40) problems.push('description too short')
for (const key of ['task', 'instruction', 'text']) {
  if (!properties[key]) problems.push(`parameters.properties.${key} missing`)
  if (!required.includes(key)) problems.push(`${key} must be required`)
}
if (!tool.output || tool.output.schema?.type !== 'string') problems.push('output schema must be string')
if (typeof tool.output?.render !== 'function') problems.push('output.render must be a function')
if (typeof tool.execute !== 'function') problems.push('execute must be a function')
console.log(`contract problems: ${problems.length === 0 ? 'none' : problems.join('; ')}`)

const h = await health({ baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey, timeoutMs: 5000 })
console.log(`server health: ${JSON.stringify(h)}`)
if (!h.ok) {
  console.log('server not reachable; skipping execute test')
  process.exit(problems.length === 0 ? 0 : 1)
}

const payload = Array.from({ length: 120 }, (_, i) =>
  `[${i}] ERROR code=E_${i % 4} file=src/module_${i % 9}.ts line=${100 + i} msg=token expired for session sid_${i * 7}`,
).join('\n')

console.log(`\nexecuting local_delegate on ${payload.length} chars...`)
const started = Date.now()
const result = await tool.execute(
  { task: 'extract', instruction: 'List the distinct ERROR codes and the number of lines mentioning src/module_3.ts.', text: payload },
  { signal: undefined },
)
console.log(`elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`)
console.log(`result type: ${typeof result}`)
console.log(`result length: ${result.length} chars (input was ${payload.length})`)
console.log('--- result ---')
console.log(result)

const rendered = tool.output.render({ task: 'extract', text: payload }, result)
console.log(`\nrendered blocks: ${rendered.length}, first block type=${rendered[0]?.type}`)

// Force the truncation path to confirm the warning is surfaced rather than silent.
//
// Two earlier versions of this check could never fail, which is worse than no
// check. A cap of 500 was never reached because the plugin takes
// `Math.max(maxInputChars, 400_000)`; and a small cap on a small payload is not
// enough either, because with the token budget unknown the plugin allows 10,000
// tokens and 4,000 ASCII characters is only about 1,000 of them. The notice
// appears when the TOKEN budget binds, so the payload has to exceed it.
console.log('\n--- truncation guard ---')
const bigPayload = `${payload}\n${Array.from({ length: 1200 }, (_, i) => `[${i}] filler record for token accounting purposes only`).join('\n')}`
const tiny = []
const ctx2 = { tools: { register: (d) => tiny.push(d) }, logger: ctx.logger }
apply(ctx2, { ...config, maxInputChars: 400_000, maxContextTokens: 0 })
const out = await tiny[0].execute({ task: 'summarize', instruction: 'What is this?', text: bigPayload }, {})
const truncated = /\[warn: payload truncat/.test(out)
console.log(`payload ${bigPayload.length} chars -> truncation notice present: ${truncated}`)
if (!truncated) problems.push('the truncation warning was not surfaced')

process.exit(problems.length === 0 ? 0 : 1)
