// Prove the self-healing path: with the server DOWN, one local_delegate call
// must start it and still return an answer.
//
// Run from the DSH profile directory:
//   cd $DSH_HOME\profiles\web ; node <this-repo>\test\test-selfheal.mjs
import { apply } from 'dsh-plugin-local-offload'
import { health } from 'dsh-plugin-local-offload/lib/http.js'

const client = { baseUrl: 'http://127.0.0.1:18080', model: 'local-qwen3-8b', apiKey: 'local-no-key', timeoutMs: 600_000 }

const before = await health(client, AbortSignal.timeout(4_000))
console.log(`server before the call: ${before.ok ? 'UP' : 'DOWN (' + before.detail + ')'}`)

const registered = []
apply({ tools: { register: (d) => registered.push(d) }, logger: { info: () => {} } },
  { ...client, maxInputChars: 120_000, maxOutputTokens: 256, temperature: 0.2 })
const tool = registered.find((t) => t.name === 'local_delegate')
if (!tool) throw new Error('local_delegate not registered')

const started = Date.now()
try {
  const result = await tool.execute({
    task: 'extract',
    instruction: 'Answer with the single word: WORKED.',
    text: 'marker line one\nmarker line two',
  }, {})
  console.log(`call succeeded in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  console.log(`result: ${JSON.stringify(result.slice(0, 200))}`)
} catch (error) {
  console.log(`call FAILED after ${((Date.now() - started) / 1000).toFixed(1)}s: ${error.message}`)
  process.exitCode = 1
}

const after = await health(client, AbortSignal.timeout(4_000))
console.log(`server after the call:  ${after.ok ? 'UP' : 'DOWN'}`)
if (!before.ok && after.ok) console.log('SELF-HEAL: the call brought the server up')
else if (before.ok) console.log('NOTE: the server was already up, so this run did not exercise recovery')
else { console.log('SELF-HEAL FAILED'); process.exitCode = 1 }
