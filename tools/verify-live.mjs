#!/usr/bin/env node
/**
 * verify-live — the end-to-end acceptance check that actually works.
 *
 * Why this exists next to `test/verify-all.mjs`
 * ---------------------------------------------
 * `verify-all.mjs` is the richer check: it validates the route against the
 * harness's own `Config` schema and compares the installed plugin copy against
 * the source. It imports `@deepseek-ai/dsh-llm-pi-ai` and the plugin **by bare
 * specifier**, and ES module resolution for a bare specifier is relative to the
 * IMPORTING FILE's directory -- never the current working directory. A script
 * that lives outside the DSH installation's `node_modules` tree therefore cannot
 * resolve them at all:
 *
 *     $ cd ~/.dsh/profiles/web
 *     $ node <repo>/test/verify-all.mjs
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-llm-pi-ai'
 *
 * Even dynamic `import()` from the profile directory fails, because the
 * specifiers inside the imported file are still resolved against that file.
 * That makes `verify-all.mjs` unusable as an acceptance check for a plugin that
 * lives in its own repository, which is a real defect rather than a quirk.
 *
 * This script takes the other route: `node:` builtins and the repository's own
 * YAML reader, the plugin located by path rather than by package name. It
 * therefore runs from anywhere, on any machine, against whatever DSH profile you
 * point it at.
 *
 * What it checks
 * --------------
 *   1. the plugin file can be imported, and registers `local_delegate`
 *   2. the registered tool's parameters and output schema are what the model
 *      contract requires
 *   3. the payload guard clamps an oversized input instead of forwarding it
 *   4. a live delegation against the configured endpoint, if one is reachable
 *   5. the exhaustiveness property: an `extract` task returns ALL four distinct
 *      error codes from a synthetic payload
 *
 * Step 5 is the behavioural regression this project cares most about. A vague
 * instruction once made an 8B model return two of four codes and stop.
 *
 * Usage:
 *   node tools/verify-live.mjs
 *   node tools/verify-live.mjs --profile web
 *   node tools/verify-live.mjs --offline          # skip the network steps
 *   node tools/verify-live.mjs --source F:\path\to\source
 *
 * Exit code 0 when no check FAILED; skipped checks do not fail the run.
 *
 * @module verify-live
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
// The shared reader, so the YAML subset is implemented once. It was duplicated
// here while this script needed only a few keys from one row; two copies of a
// parser drift, and only one of them would have received the fix for the bug that
// made a sequence of mappings lose every key after the first.
import { parseYaml } from './yaml-min.mjs'

const argv = process.argv.slice(2)
const hasFlag = (f) => argv.includes(f)
const valueOf = (f, fallback) => {
  const i = argv.indexOf(f)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const offline = hasFlag('--offline')
const dshHome = resolve(valueOf('--dsh-home', process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')))
const profileName = valueOf('--profile', 'web')
const profileDir = join(dshHome, 'profiles', profileName)
const sourceDir = resolve(valueOf('--source', join(dirname(fileURLToPath(import.meta.url)), '..')))

const failures = []
let skipped = 0
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  [${detail}]` : ''}`)
  if (!ok) failures.push(label)
}
const skip = (label, why) => { skipped++; console.log(`  SKIP  ${label}${why ? `  [${why}]` : ''}`) }
const section = (t) => console.log(`\n== ${t} ==`)

// --- reading the profile's configuration ----------------------------------

/**
 * Coerce a configured value to a string, or undefined when it is absent.
 *
 * The shared reader returns real types, so a `>-` block scalar arrives as a
 * string while `maxInlineBytes: 12000` arrives as a number. Fields this script
 * forwards to the plugin as strings go through here, so a numeric value cannot
 * reach the schema where a string is expected.
 *
 * @param {unknown} value
 * @returns {string|undefined}
 */
function text(value) {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : String(value)
}

/**
 * Pull the config of the `local-offload` row out of a profile patch.
 *
 * The profile patch is a top-level YAML sequence whose items each carry `id` and
 * `config`, so the shared reader handles it directly. Every field is passed on
 * as-is and the plugin's own `Config` schema does the validation when `apply`
 * runs.
 *
 * @param {string} patchText - the patch file's contents.
 * @returns {Record<string, unknown>}
 */
function readOffloadRow(patchText) {
  const document = parseYaml(patchText)
  if (!Array.isArray(document)) return {}
  const row = document.find((entry) => entry && typeof entry === 'object' && entry.id === 'local-offload')
  const config = row?.config
  return config && typeof config === 'object' ? config : {}
}

/** Read a credential out of the harness's own credential file. */
function readCredential(name) {
  const path = join(dshHome, '.credentials.yaml')
  if (!existsSync(path)) return undefined
  const document = parseYaml(readFileSync(path, 'utf8'))
  const value = document?.refs?.[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// --- 1. registration -------------------------------------------------------

section('1. plugin registration')

// Load the repository's own source, not the profile's installed copy.
//
// The published artifact is this checkout, so this script has to exercise it.
// The installed copy is what DSH will actually run, and `tools/doctor.mjs` is
// what compares the two -- reporting a difference there rather than silently
// testing one while claiming the other.
const pluginEntry = join(sourceDir, 'lib', 'index.js')
const installedEntry = join(profileDir, 'node_modules', 'dsh-plugin-local-offload', 'lib', 'index.js')
const entry = existsSync(pluginEntry) ? pluginEntry : installedEntry
console.log(`  using ${entry}`)
if (entry === installedEntry) {
  console.log('  (source checkout not found; testing the installed copy instead)')
} else if (!existsSync(installedEntry)) {
  console.log('  (the profile has no installed copy — run tools/doctor.mjs to see how to install it)')
} else {
  const same = readFileSync(pluginEntry).equals(readFileSync(installedEntry))
  console.log(same
    ? '  installed copy is identical to this source'
    : '  NOTE: the installed copy DIFFERS from this source; DSH will run the installed one.')
  if (!same) {
    console.log('        compare the two with: node tools/doctor.mjs')
    console.log('        this script verifies the source, which is the published artifact.')
  }
}

let plugin
try {
  plugin = await import(pathToFileURL(entry).href)
  check('plugin module imports', true, `exports ${Object.keys(plugin).join(', ')}`)
} catch (error) {
  check('plugin module imports', false, error.message)
  // The plugin imports `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools`,
  // which only resolve inside a DSH installation's `node_modules` tree. On a fresh
  // clone the import therefore fails with a bare ERR_MODULE_NOT_FOUND that says
  // nothing about the fix, so say it here rather than let the reader guess.
  if (/Cannot find package '(@deepseek-ai\/|schemastery)/.test(error.message)) {
    console.log('')
    console.log('  This checkout cannot resolve the harness packages the plugin imports.')
    console.log('  That is expected on a fresh clone -- nothing is installed. Fix it with:')
    console.log('')
    console.log('      node tools/setup-dev.mjs')
    console.log('')
    console.log('  It points this checkout at the harness already on your machine.')
  }
}

let registered = []
let chainEntries = 0
let client
if (plugin) {
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const row = existsSync(patchPath) ? readOffloadRow(readFileSync(patchPath, 'utf8')) : {}

  // Pass `apiKeyEnv` through as the NAME, exactly as DSH does at composition
  // time. It is tempting to resolve the key here and hand the plugin a ready
  // value, and an earlier version of this script did that -- which made it pass
  // while the real runtime failed, because nothing in the harness exports
  // `.credentials.yaml` into `process.env`. Testing the plugin's own resolution
  // is the point of this script.
  const config = {
    baseUrl: text(row.baseUrl) ?? 'http://127.0.0.1:18080',
    model: text(row.model) ?? 'local-qwen3-8b',
    apiKey: text(row.apiKey) ?? 'local-no-key',
    apiKeyEnv: text(row.apiKeyEnv) ?? '',
    // Passed explicitly rather than left to the schema default, so the check
    // follows `--dsh-home` instead of the ambient environment.
    credentialsFile: join(dshHome, '.credentials.yaml'),
    timeoutMs: Number(row.timeoutMs ?? 300000),
    maxInputChars: Number(row.maxInputChars ?? 400000),
    maxOutputTokens: Number(row.maxOutputTokens ?? 1024),
    temperature: Number(row.temperature ?? 0.2),
    maxContextTokens: Number(row.maxContextTokens ?? 0),
    extraBody: '',
    chain: text(row.chain) ?? '',
    chainApiKeyEnv: text(row.chainApiKeyEnv) ?? '',
    cooldownSeconds: Number(row.cooldownSeconds ?? 65),
  }
  client = { baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey, timeoutMs: config.timeoutMs }

  console.log(`  configured: ${config.baseUrl} model=${config.model} chain=${config.chain ? 'yes' : 'no'}`)
  if (config.apiKeyEnv) {
    const fromEnv = process.env[config.apiKeyEnv]
    const fromFile = readCredential(config.apiKeyEnv)
    const source = fromEnv ? 'launch environment' : fromFile ? 'the credential file' : 'RESOLVES NOWHERE'
    console.log(`  credential ${config.apiKeyEnv}: ${source}`)
    console.log(`  (the plugin resolves this itself, per request; this line only reports what it will find)`)
  }

  try {
    plugin.apply(
      { tools: { register: (def) => registered.push(def) }, logger: { info: () => {}, warn: () => {} } },
      config,
    )
    check('apply() completes', true)
  } catch (error) {
    check('apply() completes', false, error.message)
  }
  chainEntries = (() => {
    if (!config.chain) return 0
    try { return JSON.parse(config.chain).length } catch { return -1 }
  })()
  if (chainEntries === -1) check('chain parses as JSON', false, config.chain.slice(0, 80))
  else check('chain parses as JSON', true, `${chainEntries} endpoint(s)`)
}

// --- 2. the tool contract --------------------------------------------------

section('2. tool contract')

const tool = registered.find((t) => t.name === 'local_delegate')
check('local_delegate is registered', Boolean(tool), `registered: ${registered.map((t) => t.name).join(', ') || 'none'}`)

if (tool) {
  // The registered shape is `parameters: { type, properties, required }`, verified
  // by dumping what `defineTool` produces. `parameters.task` does not exist; a
  // fallback reading it is dead code that hides a wrong assumption.
  const properties = tool.parameters?.properties ?? {}
  const required = tool.parameters?.required ?? []
  check('task, instruction and text are all required',
    ['task', 'instruction', 'text'].every((k) => required.includes(k) && Boolean(properties[k])),
    `required: ${required.join(', ')}`)
  const tasks = properties.task?.enum ?? []
  check('all seven task contracts are offered', tasks.length === 7, `${tasks.length}: ${tasks.join(', ')}`)
  check('output schema is a string', tool.output?.schema?.type === 'string')
  check('a description is present for the model', typeof tool.description === 'string' && tool.description.length > 40)
}

// --- 3. the payload guard --------------------------------------------------

section('3. payload guard')

if (!tool) {
  skip('oversized payload is clamped, not forwarded', 'no tool registered')
} else if (!tool.execute) {
  skip('oversized payload is clamped, not forwarded', 'tool has no execute')
} else if (offline) {
  skip('oversized payload is clamped, not forwarded', '--offline')
} else {
  // A payload far over any endpoint's window. If the guard were absent this
  // would be sent whole and, on a local server, take the process down -- which
  // is exactly the failure that motivated the guard.
  const huge = 'x'.repeat(1_500_000)
  try {
    const out = await tool.execute({ task: 'classify', instruction: 'Answer with the single word OK.', text: huge }, {})
    // The assertion matches the notice's opening words rather than its whole
    // text, so that rewording the message does not silently disable the check
    // while a genuine removal of the notice still fails it.
    const notice = /\[warn: payload truncat/.exec(String(out))
    check('clamping is reported to the caller', Boolean(notice), String(out).slice(-200))
  } catch (error) {
    // A failure here is still evidence the guard engaged, but it is not a pass:
    // the contract is to truncate and say so, not to throw.
    check('clamping is reported to the caller', false, error.message.slice(0, 200))
  }
}

// --- 4 and 5. live behaviour ----------------------------------------------

section('4. live delegation')

if (offline) {
  skip('the endpoint answers', '--offline')
  skip('extract is exhaustive (all four codes)', '--offline')
} else if (!tool) {
  skip('the endpoint answers', 'no tool registered')
} else {
  const payload = Array.from({ length: 60 }, (_, i) =>
    `[${i}] ERROR code=E_${i % 4} file=src/m_${i % 8}.ts line=${100 + i}`).join('\n')

  let answer = ''
  const started = Date.now()
  try {
    const out = await tool.execute({
      task: 'extract',
      instruction: 'List every distinct ERROR code, comma separated. Nothing else.',
      text: payload,
    }, {})
    answer = String(out).split('\n\n[')[0].trim()
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`  ${payload.length} chars in -> ${String(out).length} chars out in ${seconds}s`)
    console.log(`  answer: ${answer.slice(0, 120)}`)
    console.log(`  trailer: ${String(out).split('\n\n[')[1]?.split('\n')[0] ?? '(none)'}`)
    check('the endpoint answered', answer.length > 0)
  } catch (error) {
    check('the endpoint answered', false, error.message.slice(0, 240))
  }

  section('5. exhaustiveness regression')
  if (answer.length === 0) {
    skip('extract is exhaustive (all four codes)', 'no answer to inspect')
  } else {
    const found = ['E_0', 'E_1', 'E_2', 'E_3'].filter((code) => answer.includes(code))
    check('extract returns all four distinct codes',
      found.length === 4,
      `found ${found.length}/4: ${found.join(', ') || 'none'}`)
  }
}

// --- summary ---------------------------------------------------------------

console.log('\n== summary ==')
if (failures.length === 0) {
  console.log('ALL CHECKS PASS')
  if (skipped > 0) console.log(`(${skipped} check(s) skipped)`)
  console.log(`Endpoint: ${client?.baseUrl ?? 'unknown'}  model: ${client?.model ?? 'unknown'}  chain: ${chainEntries} endpoint(s)`)
} else {
  console.log(`${failures.length} FAILURE(S):`)
  for (const f of failures) console.log(`  - ${f}`)
  console.log('')
  console.log('If "the endpoint answered" failed, the message names the endpoint and the')
  console.log('HTTP status. A 429 means the free allowance for that model is spent: the')
  console.log('chain should have rotated, so a 429 here means the whole chain was')
  console.log('exhausted. See docs/troubleshooting.md.')
}
process.exitCode = failures.length === 0 ? 0 : 1
