// Credential resolution: which source wins, and what happens when none does.
//
// This file exists because the first shipped version was wrong in a way that no
// test caught and no log explained. The plugin read `process.env[apiKeyEnv]`,
// but `dsh-credentials-local` stores keys in `<DSH_HOME>/.credentials.yaml` and
// resolves them for the harness's own routes WITHOUT materializing them into the
// environment. Verified across the installed harness: the only two writers of
// `process.env` are `dsh-app-boot` (which materializes `.env` FILES, a different
// store) and `dsh-http-proxy`. So every user who saved a key the documented way
// got a placeholder sent to the endpoint and a 401 on the first call.
//
// Usage: node test/test-credentials.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

// Resolved from this file's location, not `process.cwd()`. The earlier version
// used the working directory, so the test only ran when invoked from the
// repository root -- `node test/test-credentials.mjs` from anywhere else failed
// with a bare "module not found" that pointed at the wrong problem.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = pathToFileURL(join(repoRoot, 'lib', 'index.js')).href

let readCredentialFile
let resolveCredential
try {
  ({ readCredentialFile, resolveCredential } = await import(entry))
} catch (error) {
  // The plugin imports `@deepseek-ai/schemastery`, which resolves only inside a
  // DSH installation. On a fresh clone that import fails, so name the fix.
  if (/Cannot find package '(@deepseek-ai\/|schemastery)/.test(error.message)) {
    console.error('Cannot load the plugin because this checkout does not resolve the harness packages.')
    console.error('Run this once, then retry:  node tools/setup-dev.mjs')
    process.exit(4)
  }
  throw error
}

let failures = 0
const check = (label, actual, expected) => {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  [got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}]`}`)
}

const dir = mkdtempSync(join(tmpdir(), 'local-offload-cred-'))
const credFile = join(dir, '.credentials.yaml')

/** The real store's structure, including a sibling block before `refs:`. */
writeFileSync(credFile, [
  'version: 1',
  'records:',
  '  client-connection/browser-session:',
  '    kind: grant',
  '    payload:',
  '      secret: not-a-credential',
  'refs:',
  '  DEEPSEEK_API_KEY: sk-d846abcdef',
  '  LOCAL_LLM_KEY: local-no-key',
  '  # a comment line that must not be read as a credential',
  '  SILICONFLOW_API_KEY: sk-lkqtabcdef',
  '  QUOTED_KEY: "sk-quoted"',
  '  PLACEHOLDER_KEY: sk-REPLACE_WITH_YOUR_KEY',
  '  EMPTY_KEY:',
].join('\n'), 'utf8')

const base = { apiKey: 'local-no-key', apiKeyEnv: '', credentialsFile: credFile }
const fakeEnv = (name, value) => {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

console.log('== reading the credential file ==')

check('a saved key is read', readCredentialFile(credFile, 'SILICONFLOW_API_KEY'), 'sk-lkqtabcdef')
check('a key whose value contains underscores is read whole', readCredentialFile(credFile, 'LOCAL_LLM_KEY'), 'local-no-key')
check('quotes around a value are stripped', readCredentialFile(credFile, 'QUOTED_KEY'), 'sk-quoted')
check('a key inside the earlier `records:` block is not read',
  readCredentialFile(credFile, 'secret'), undefined)
check('an unknown name yields undefined', readCredentialFile(credFile, 'NOT_THERE'), undefined)
check('the REPLACE_WITH_YOUR marker is treated as unset',
  readCredentialFile(credFile, 'PLACEHOLDER_KEY'), undefined)
check('a key with no value yields undefined', readCredentialFile(credFile, 'EMPTY_KEY'), undefined)
check('a missing file yields undefined',
  readCredentialFile(join(dir, 'nope.yaml'), 'SILICONFLOW_API_KEY'), undefined)
check('an empty path yields undefined', readCredentialFile('', 'SILICONFLOW_API_KEY'), undefined)

console.log('\n== resolution order ==')

fakeEnv('SILICONFLOW_API_KEY', undefined)
check('falls back to the credential file when the environment has nothing',
  resolveCredential({ ...base, apiKeyEnv: 'SILICONFLOW_API_KEY' }, 'SILICONFLOW_API_KEY', credFile).source,
  'credentials-file')

fakeEnv('SILICONFLOW_API_KEY', 'sk-from-launch-env')
const withEnv = resolveCredential({ ...base, apiKeyEnv: 'SILICONFLOW_API_KEY' }, 'SILICONFLOW_API_KEY', credFile)
check('the launch environment wins over the file', withEnv.source, 'environment')
check('and its value is the environment one', withEnv.value, 'sk-from-launch-env')
fakeEnv('SILICONFLOW_API_KEY', undefined)

check('an empty apiKeyEnv means a literal from config',
  resolveCredential({ ...base, apiKeyEnv: '' }, '', credFile).source, 'literal')

const nowhere = resolveCredential({ ...base, apiKeyEnv: 'SILICONFLOW_API_KEY' }, 'MISSING_NAME', credFile)
check('a name present nowhere falls back to the literal', nowhere.source, 'literal-fallback')
check('and reports the configured placeholder', nowhere.value, 'local-no-key')

const disabled = resolveCredential({ ...base, apiKeyEnv: 'SILICONFLOW_API_KEY' }, 'SILICONFLOW_API_KEY', undefined)
check('disabling the file lookup skips it entirely', disabled.source, 'literal-fallback')

console.log('\n== the regression this file was written for ==')
fakeEnv('SILICONFLOW_API_KEY', undefined)
const beforeFixWouldSend = 'local-no-key'
const nowSends = resolveCredential({ ...base, apiKeyEnv: 'SILICONFLOW_API_KEY' }, 'SILICONFLOW_API_KEY', credFile).value
check('a key saved only in the credential file is no longer sent as a placeholder',
  nowSends !== beforeFixWouldSend, true)

console.log('\n== the plugin exports what the schema default needs ==')
check('credentialsFileDefault points at the harness home',
  typeof (await import(entry)).credentialsFileDefault === 'function', true)

rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL CHECKS PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
