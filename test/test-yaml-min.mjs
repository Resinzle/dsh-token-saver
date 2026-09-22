// Validate tools/yaml-min.mjs against the real DSH config files.
//
// The plugin ships no YAML dependency, so its own reader has to be trustworthy
// for the two files the measurement scripts read. This compares it, value for
// value, against `js-yaml` when that package happens to be resolvable -- which it
// is from inside a DSH profile tree. Where `js-yaml` is absent the test still runs
// its structural assertions, and says so.
//
// Usage:
//   node test/test-yaml-min.mjs                 # structural checks always run
//   node test/test-yaml-min.mjs --compare <dir> # also diff against js-yaml
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseYaml } from '../tools/yaml-min.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  [${detail}]` : ''}`)
  if (!ok) failures++
}

// --- fixtures covering the constructs the DSH files use --------------------

console.log('== parser behaviour ==')

const nested = parseYaml([
  'ui-onboarding:',
  '  welcomeNoticeVersion: 2026-08-13.1',
  'agent-default-model:',
  '  provider: deepseek-official',
  '  reasoningEffort: high',
].join('\n'))
check('nested mappings', nested?.['agent-default-model']?.provider === 'deepseek-official')
check('a version-like value stays a string', nested?.['ui-onboarding']?.welcomeNoticeVersion === '2026-08-13.1')

const seq = parseYaml([
  'llm-pi-ai:',
  '  providers:',
  '    local:',
  '      models:',
  '        - id: "Bonsai-8B-Q1_0"',
  '          name: "Bonsai-8B-Q1_0 (1.1 GB)"',
  '          contextWindow: 32768',
  '          input: [text]',
  '        - id: "second"',
  '          maxTokens: 4096',
].join('\n'))
const models = seq?.['llm-pi-ai']?.providers?.local?.models
check('sequence of mappings', Array.isArray(models) && models.length === 2, `${models?.length} item(s)`)
check('inline first key of a sequence item', models?.[0]?.id === 'Bonsai-8B-Q1_0')
check('subsequent keys of the same item', models?.[0]?.contextWindow === 32768)
check('second item parsed independently', models?.[1]?.id === 'second')
check('quoted values lose their quotes', models?.[0]?.name === 'Bonsai-8B-Q1_0 (1.1 GB)')

const comments = parseYaml([
  'refs:',
  '  # a comment line',
  '  KEY_ONE: sk-abc#notacomment',
  '  KEY_TWO: "value # inside quotes"',
  '  KEY_THREE: plain value   # trailing comment',
  '  EMPTY:',
  '  PLACEHOLDER: sk-REPLACE_WITH_YOUR_KEY',
].join('\n'))
check('a # without preceding space is not a comment', comments?.refs?.KEY_ONE === 'sk-abc#notacomment')
check('a # inside quotes is not a comment', comments?.refs?.KEY_TWO === 'value # inside quotes')
check('a trailing comment is stripped', comments?.refs?.KEY_THREE === 'plain value')
check('an empty value is present as an empty string', comments?.refs?.EMPTY === '')
check('a comment line between keys is skipped', comments?.refs?.PLACEHOLDER === 'sk-REPLACE_WITH_YOUR_KEY')

const scalars = parseYaml([
  'boolTrue: true',
  'boolFalse: false',
  'nullTilde: ~',
  'int: 131072',
  'float: 0.2',
  'quotedBool: "true"',
  'colonInValue: https://api.siliconflow.cn/v1',
].join('\n'))
check('true/false are booleans', scalars?.boolTrue === true && scalars?.boolFalse === false)
check('~ is null', scalars?.nullTilde === null)
check('integers are numbers', scalars?.int === 131072)
check('floats are numbers', scalars?.float === 0.2)
check('a quoted boolean stays a string', scalars?.quotedBool === 'true')
check('a URL value survives', scalars?.colonInValue === 'https://api.siliconflow.cn/v1')

const blocks = parseYaml([
  'chain: >-',
  '  ["https://api.siliconflow.cn/v1|THUDM/GLM-4-9B-0414",',
  '   "https://api.siliconflow.cn/v1|Qwen/Qwen3-8B"]',
  'next: after',
].join('\n'))
check('folded block scalar joins its lines', String(blocks?.chain).includes('GLM-4-9B-0414') && String(blocks?.chain).includes('Qwen3-8B'))
check('the key after a block scalar still parses', blocks?.next === 'after')

const empty = parseYaml('')
check('empty input yields undefined', empty === undefined)

const seqOfScalars = parseYaml('list:\n  - one\n  - two\n')
check('sequence of scalars', Array.isArray(seqOfScalars?.list) && seqOfScalars.list[1] === 'two')

// --- comparison against the real files ------------------------------------

const compareDir = (() => {
  const i = process.argv.indexOf('--compare')
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
  return home
})()

console.log(`\n== against real files in ${compareDir} ==`)

/**
 * Parse a document with `js-yaml`, run from a directory where Node can resolve it.
 *
 * Resolution is delegated to a child Node process rather than guessed at. An
 * earlier version imported a fixed path such as
 * `<dir>/node_modules/js-yaml/dist/js-yaml.mjs`; on the machine this was written
 * for, `js-yaml` sits in the npx cache rather than beside the profile, so the
 * comparison silently degraded to "skipped" and proved nothing. A bare specifier
 * in an eval script resolves against the child's working directory, so asking
 * Node with `cwd` set is exact.
 *
 * @param {string} cwd - directory to run the child in.
 * @param {string} text - the YAML document.
 * @returns {Promise<unknown|undefined>} the parsed value, or undefined when unavailable.
 */
async function parseWithJsYaml(cwd, text) {
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    "import yaml from 'js-yaml'; let s=''; process.stdin.on('data', (c) => { s += c }); process.stdin.on('end', () => { process.stdout.write(JSON.stringify(yaml.load(Buffer.from(s, 'base64').toString('utf8')) ?? null)) })",
  ], {
    cwd,
    input: Buffer.from(text, 'utf8').toString('base64'),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.status !== 0 || !result.stdout) return undefined
  try { return JSON.parse(result.stdout) } catch { return undefined }
}

/**
 * Directories worth trying as the child's working directory.
 *
 * The npx cache is included because that is where `js-yaml` lived on the machine
 * this was developed on: DSH is often launched through `npx`, which installs the
 * harness and its dependencies into `_npx/<hash>/node_modules` rather than a
 * global prefix.
 */
const jsYamlCandidates = (() => {
  const found = [compareDir, join(compareDir, 'profiles', 'web'), join(compareDir, 'profiles')]
  const npxCache = join(process.env.LOCALAPPDATA ?? '', 'npm-cache', '_npx')
  try {
    for (const entry of readdirSync(npxCache, { withFileTypes: true })) {
      if (entry.isDirectory()) found.push(join(npxCache, entry.name, 'node_modules'))
    }
  } catch { /* no npx cache */ }
  return found
})()

let jsYamlCwd
for (const candidate of jsYamlCandidates) {
  if (await parseWithJsYaml(candidate, 'probe: ok\n') !== undefined) { jsYamlCwd = candidate; break }
}
const haveJsYaml = jsYamlCwd !== undefined

/** Compare two parsed documents recursively and report the first difference. */
function diff(a, b, path = '') {
  if (a === b) return undefined
  if (typeof a !== typeof b) return `${path || '<root>'}: ${typeof a} vs ${typeof b} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`
  if (a === null || b === null) return `${path || '<root>'}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${path || '<root>'}: array vs non-array`
    if (a.length !== b.length) return `${path || '<root>'}: length ${a.length} vs ${b.length}`
    for (let i = 0; i < a.length; i++) {
      const d = diff(a[i], b[i], `${path}[${i}]`)
      if (d) return d
    }
    return undefined
  }
  if (typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys) {
      const d = diff(a[k], b[k], path ? `${path}.${k}` : k)
      if (d) return d
    }
    return undefined
  }
  return `${path || '<root>'}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`
}

for (const name of ['settings.yaml', '.credentials.yaml']) {
  const path = join(compareDir, name)
  if (!existsSync(path)) { console.log(`  SKIP  ${name} (not present)`); continue }
  const text = readFileSync(path, 'utf8')
  const mine = parseYaml(text)
  if (!haveJsYaml) {
    check(`${name} parses to a mapping`, mine !== null && typeof mine === 'object', `${Object.keys(mine ?? {}).length} top-level key(s)`)
    continue
  }
  const theirs = await parseWithJsYaml(jsYamlCwd, text)
  const difference = diff(mine, theirs)
  check(`${name} matches js-yaml exactly`, difference === undefined, difference ?? 'identical')
}

if (!haveJsYaml) {
  console.log('\n  NOTE  js-yaml could not be resolved, so the exact-match comparison was skipped.')
  console.log('        It is normally resolvable inside a DSH installation tree. Point --compare')
  console.log("        at a directory where `node -e \"import('js-yaml')\"` succeeds to include it:")
  console.log(`          node ${join(repo, 'test', 'test-yaml-min.mjs')} --compare <dir>`)
} else {
  console.log('\n  js-yaml was available, so the comparison above is an exact value-for-value diff.')
}

console.log(failures === 0 ? '\nALL CHECKS PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
