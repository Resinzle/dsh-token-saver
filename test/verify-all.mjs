// Acceptance check for the CURRENT token-saving deployment.
//
// Run from the DSH profile directory so harness packages resolve:
//   cd $DSH_HOME\profiles\web ; node <this-repo>\test\verify-all.mjs
//
// The architecture this checks, in one paragraph: the paid model stays primary
// and the goal is to spend fewer of ITS tokens. Bulk text is handed to a free
// hosted model through `local_delegate`, which falls back to a local llama.cpp
// server when the free tier is rate-limited. Oversized tool output is spilt at
// insertion so it never enters history. The local server is deliberately NOT
// auto-started: it occupies VRAM for as long as it runs, and it is a fallback
// brought up on demand rather than a default.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, basename } from 'node:path'
import { parseYaml } from '../tools/yaml-min.mjs'
import { Config } from '@deepseek-ai/dsh-llm-pi-ai'
import { apply, name as pluginName } from 'dsh-plugin-local-offload'
import { health } from 'dsh-plugin-local-offload/lib/http.js'

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE, '.dsh')
const profileDir = join(dshHome, 'profiles', 'web')
const sourceDir = 'F:\\bonsai\\offload-plugin'
const patchPath = join(profileDir, 'cordis.patch.yml')

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures.push(label)
}

console.log('== 1. global instructions ==')
try {
  const text = readFileSync(join(dshHome, 'AGENTS.md'), 'utf8')
  check('AGENTS.md exists (loaded by every session)', true, `${text.length} chars`)
  for (const [label, needle] of [
    ['delegation guidance', 'local_delegate'],
    ['model routing', '免费模型分工'],
    ['tool-output discipline', '工具输出纪律'],
    ['encoding rules', '编码铁律'],
    ['ask-the-user rule', '先问用户'],
  ]) check(`AGENTS.md covers ${label}`, text.includes(needle))
} catch (error) {
  check('AGENTS.md exists', false, error.message)
}

console.log('\n== 2. free model routes ==')
const settings = parseYaml(readFileSync(join(dshHome, 'settings.yaml'), 'utf8'))
const parsed = new Config(settings['llm-pi-ai'])
const sf = parsed.providers.siliconflow
check('siliconflow route validates against the adapter schema', Boolean(sf))
check('route points at the documented endpoint', sf?.baseURL === 'https://api.siliconflow.cn/v1', String(sf?.baseURL))
check('route declares free models', (sf?.models ?? []).length > 0, `${sf?.models?.length} models`)
const creds = parseYaml(readFileSync(join(dshHome, '.credentials.yaml'), 'utf8'))
const key = (creds.refs ?? {})[sf?.apiKeyEnv]
check('its credential resolves to a real value',
  typeof key === 'string' && key.length > 20 && !key.includes('REPLACE_WITH_YOUR'),
  key ? `${key.length} chars` : 'missing')

console.log('\n== 3. delegation plugin ==')

/**
 * The files npm would actually install, per `package.json`'s `files` allow-list.
 *
 * Comparing the whole repository against the installed copy was wrong: `files`
 * deliberately excludes `docs/`, `templates/`, `test/`, `tools/`, `.github/` and
 * `README.zh.md`, so a plugin installed into a profile SHOULD lack them. The old
 * comparison therefore reported twelve "missing" files on a perfectly correct
 * install -- a false alarm that would train the reader to ignore this check.
 *
 * `files` names directories (`lib`), so an entry is expanded to every file beneath
 * it. Both `README.md` and `LICENSE` are listed explicitly and are included.
 */
function installedPayload() {
  const manifest = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8'))
  const out = []
  for (const entry of manifest.files ?? []) {
    const full = join(sourceDir, entry)
    let stat
    try { stat = statSync(full) } catch { continue }
    if (stat.isDirectory()) out.push(...listFiles(sourceDir, entry))
    else out.push(entry.split('\\').join('/'))
  }
  return out
}

function listFiles(root, prefix = '') {
  const out = []
  for (const e of readdirSync(prefix ? join(root, prefix) : root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...listFiles(root, rel))
    else out.push(rel)
  }
  return out
}

const payload = installedPayload()
const differing = []
for (const rel of payload) {
  try {
    if (!readFileSync(join(sourceDir, rel))
      .equals(readFileSync(join(profileDir, 'node_modules', 'dsh-plugin-local-offload', rel)))) differing.push(rel)
  } catch { differing.push(`${rel} (missing)`) }
}
check(`installed copy matches the ${payload.length} file(s) the package ships`, differing.length === 0,
  differing.join(', ') || `all ${payload.length} files`)
if (differing.length > 0) {
  // Say what to do, not just what is wrong. "missing" alone reads as a broken
  // repository when the usual cause is simply a stale installed copy -- a `file:`
  // dependency is a copy, so any edit here exists only in the checkout until DSH
  // is told to reinstall. Verified by cloning this repository: the clone differs
  // from the profile's copy in exactly the files that changed since the install.
  console.log(`        the source checkout and the profile's installed copy differ;`)
  console.log(`        reinstall, then restart DSH:`)
  console.log(`          dsh plugin --profile ${basename(profileDir)} add "${sourceDir}"`)
}

const registered = []
apply({ tools: { register: (d) => registered.push(d) }, logger: { info: () => {}, warn: () => {} } },
  {
    baseUrl: sf.baseURL, model: sf.models[0].id, apiKey: key, apiKeyEnv: '', timeoutMs: 120_000,
    maxInputChars: 400_000, maxOutputTokens: 512, temperature: 0.2, maxContextTokens: 131_072, fallback: '',
  })
check('plugin registers under the expected name', pluginName === 'local-offload')
const tool = registered.find((t) => t.name === 'local_delegate')
check('local_delegate is registered', Boolean(tool))
if (tool) {
  const req = tool.parameters?.required ?? []
  check('required params are task/instruction/text', ['task', 'instruction', 'text'].every((k) => req.includes(k)))
  check('output schema is a string', tool.output?.schema?.type === 'string')
}

console.log('\n== 4. live delegation (free route) ==')
if (tool) {
  const payload = Array.from({ length: 60 }, (_, i) =>
    `[${i}] ERROR code=E_${i % 4} file=src/m_${i % 8}.ts line=${100 + i}`).join('\n')
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
    check('the free route answered', answer.length > 0)
    // Exhaustiveness regression: a vague instruction made the 8B model return
    // 2 of 4 codes, so the system prompt now demands full coverage and this
    // asserts it stays that way.
    check('answer is exhaustive (all four codes)',
      ['E_0', 'E_1', 'E_2', 'E_3'].every((c) => answer.includes(c)), answer.slice(0, 80))
  } catch (error) {
    check('free route answered', false, error.message.slice(0, 200))
  }
}

console.log('\n== 5. profile patch (the mechanisms that save tokens) ==')
const patch = readFileSync(patchPath, 'utf8')
check('spill cap lowered to 12 KB (was 50 KB and never fired)', /maxInlineBytes:\s*12000/.test(patch))
check('delegation points at the free route', /baseUrl:\s*https:\/\/api\.siliconflow\.cn\/v1/.test(patch))
check('rotation chain is configured', /chain:/.test(patch) && /GLM-4-9B-0414/.test(patch))
check('the chain ends at the local server (no quota)', /127\.0\.0\.1:18080\|/.test(patch))
check('rate-limited endpoints get a per-minute cooldown', /cooldownSeconds:\s*6\d/.test(patch))
check('session titles routed off the paid API', /provider:\s*siliconflow/.test(patch))
check('session search index is durable', /session-search\.db/.test(patch))
// The reasoning-only free models must stay out of the chain: they ignore
// enable_thinking and burn 68-143 output tokens on a one-word answer.
const chainBlock = (patch.match(/chain:[\s\S]*?\]/) ?? [''])[0]
check('reasoning-only models excluded from the chain',
  !/GLM-Z1-9B/.test(chainBlock) && !/DeepSeek-R1-0528/.test(chainBlock))

console.log('\n== 6. local fallback (optional; expected idle) ==')
const local = await health({ baseUrl: 'http://127.0.0.1:18080', model: 'x', apiKey: 'x', timeoutMs: 4000 })
console.log(local.ok
  ? '  note: the local server is running, so the fallback is warm'
  : '  note: the local server is stopped (expected; it is started on demand)')
const launcher = process.env.DSH_LAUNCHER
  ?? join(dshHome, '..', 'OneDrive', '\u6587\u6863', '\u5343\u661f\u5947\u57df', 'dsh-launcher.ps1')
if (existsSync(launcher)) {
  const lt = readFileSync(launcher, 'utf8')
  // Look for an UNCOMMENTED call, not for the name anywhere in the file. The
  // functions `Test-LocalAiPort` and `Start-LocalAi` are deliberately kept so the
  // server can still be started by hand; asserting `!text.includes('Start-LocalAi')`
  // therefore failed on a correct file. What must not exist is a bare invocation.
  const callsAutoStart = /^\s*Start-LocalAi\s*$/m.test(lt)
  check('launcher no longer auto-starts the local server', !callsAutoStart)
  check('launcher kept its UTF-8 BOM (Chinese stays readable)', readFileSync(launcher)[0] === 0xef)
  check('launcher still has its original Chinese header', lt.includes('\u542F\u52A8\u5668'))
} else {
  // These assertions are about one machine's launcher script. Failing because the
  // file is absent would say nothing about the plugin, and passing silently would
  // imply they ran. Report the skip.
  console.log(`  SKIP  launcher checks (no launcher at ${launcher}; set DSH_LAUNCHER to override)`)
}

console.log('\n== 7. encoding guard ==')
const scan = spawnSync(process.execPath, [join(sourceDir, 'test', 'check-bom.mjs'), dshHome], { encoding: 'utf8' })
for (const line of `${scan.stdout ?? ''}${scan.stderr ?? ''}`.trim().split('\n')) console.log(`  ${line}`)
check('no BOM or unparseable JSON under $DSH_HOME', scan.status === 0)

console.log('\n== summary ==')
if (failures.length === 0) {
  console.log('ALL CHECKS PASS')
  console.log('The setup is global: AGENTS.md reaches every session, and the profile')
  console.log('patch applies to every session on this profile.')
} else {
  console.log(`${failures.length} FAILURE(S):`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exitCode = 1
}
