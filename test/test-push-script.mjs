// Verify tools/push-to-github.mjs, focusing on the credential promise.
//
// The script asks the user to hand over a token that can write to their GitHub
// account, and in exchange promises four things:
//
//   1. the token never enters `.git/config`
//   2. no credential helper is persisted, locally or globally
//   3. the token is never echoed
//   4. the temporary file is deleted even when the push FAILS
//
// A promise like that is worth exactly as much as its test.
//
// What is NOT tested here, and why
// --------------------------------
// A successful push is not exercised. The obvious fixture -- a local `git daemon`
// -- cannot serve a push in this environment: the sandbox rejects `SO_KEEPALIVE`
// on the accepted socket ("unable to set SO_KEEPALIVE on socket: Input/output
// error"), after which git reports "the remote end hung up unexpectedly" and the
// push hangs until killed. That was verified directly, not assumed.
//
// So this covers everything up to and including the credential helper, plus the
// full failure path, which is where a leftover credential would actually hurt. The
// success path is exercised for real the first time the user pushes to GitHub.
//
// Usage: node test/test-push-script.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  [${detail}]` : ''}`)
  if (!ok) failures.push(label)
}

const scratch = mkdtempSync(join(tmpdir(), 'push-test-'))
const work = join(scratch, 'work')
const gitIn = (args, cwd = work) => spawnSync('git', args, { cwd, encoding: 'utf8' })

gitIn(['init', '--initial-branch=main', work], scratch)
gitIn(['config', 'user.email', 'test@example.com'])
gitIn(['config', 'user.name', 'Test'])
writeFileSync(join(work, 'README.md'), '# fixture\n', 'utf8')
gitIn(['add', '-A'])
gitIn(['commit', '-m', 'initial'])

const TOKEN = 'ghp_SEKRIT_must_never_be_stored_1234567890'
const tempDir = tmpdir()
const tokenFiles = () => readdirSync(tempDir).filter((f) => f.startsWith('dsh-push-token-'))

/** Run the script exactly as a user would. An unreachable remote makes it fail. */
const runScript = (extra = []) => {
  const result = spawnSync(process.execPath, [
    join(repoRoot, 'tools', 'push-to-github.mjs'),
    '--source', work,
    '--branch', 'main',
    ...extra,
  ], { encoding: 'utf8', timeout: 90000 })
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

const before = tokenFiles().length

try {
  // --- 1. --status must not touch the network or the credentials -----------

  console.log('== --status is read-only ==')
  writeFileSync(join(work, 'pending.txt'), 'pending\n', 'utf8')
  const statusRun = runScript(['--remote', 'https://github.com/example/nope.git', '--status'])
  check('it exits 0', statusRun.status === 0, `status ${statusRun.status}`)
  check('it stops before committing', /--status given, stopping here/.test(statusRun.out))
  check('the pending file was NOT committed', /nothing pending/.test(statusRun.out) === false
    ? gitIn(['status', '--porcelain']).stdout.includes('pending.txt')
    : false)

  // --- 2. the failure path: the credential must not survive ----------------

  console.log('\n== -Token against an unreachable remote ==')
  const failRun = runScript([
    '--remote', 'https://127.0.0.1:9/does-not-exist.git',
    '--token', TOKEN,
    '--message', 'test commit',
  ])
  const out = failRun.out
  check('it exits non-zero', failRun.status !== 0, `status ${failRun.status}`)
  check('it reports the failure rather than swallowing it',
    /WARN|push exited|unreachable|could not|not resolve/i.test(out))
  check('it reports removing the one-shot helper', /one-shot helper removed/.test(out))

  const config = readFileSync(join(work, '.git', 'config'), 'utf8')
  check('the token is NOT in .git/config', !config.includes(TOKEN))
  check('no credential.helper was persisted in .git/config', !/credential\.helper/.test(config),
    /credential\.helper/.test(config) ? config.split('\n').filter((l) => l.includes('credential')).join(' | ') : 'absent')
  check('the token was NOT echoed to the output', !out.includes(TOKEN))
  check('the placeholder replacement was used if anything matching appeared',
    !out.includes('dsh-push-token-') || out.includes('<token>'), 'checked')

  const globalHelper = spawnSync('git', ['config', '--global', '--get-all', 'credential.helper'], { encoding: 'utf8' })
  check('nothing was written to the global git config',
    !(globalHelper.stdout ?? '').includes('dsh-push-token'), (globalHelper.stdout ?? '').trim() || '(unset)')

  const leftover = tokenFiles()
  check('no token file was left in the temp directory', leftover.length === before,
    leftover.length === before ? 'none' : `left behind: ${leftover.join(', ')}`)

  // --- 3. the commit still happened, and the BOM guard ran ----------------

  console.log('\n== the commit and the BOM guard ==')
  const log = gitIn(['log', '--oneline']).stdout
  check('the pending change was committed before pushing', /test commit/.test(log), log.trim().split('\n')[0])
  check('the BOM guard reported on changed .json files', /no BOM in any changed \.json file|JSON file\(s\) start with a UTF-8 BOM/.test(out))

  // --- 4. a BOM in a changed .json file must be called out ----------------

  console.log('\n== a BOM in a changed .json file is reported ==')
  // Written with PowerShell-style BOM bytes on purpose: this is the exact damage
  // that stops DSH from booting.
  writeFileSync(join(work, 'manifest.json'), Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('{"a":1}\n')]))
  const bomRun = runScript(['--remote', 'https://127.0.0.1:9/nope.git', '--token', TOKEN])
  check('the BOM is reported as a problem', /start with a UTF-8 BOM/.test(bomRun.out))
  check('it names the offending file', /manifest\.json/.test(bomRun.out))
  check('it points at the checker that lists every file', /check-bom\.mjs/.test(bomRun.out))
  check('still no token file left behind', tokenFiles().length === before)

  // --- 5. no --remote must not pretend to push ----------------------------

  console.log('\n== no --remote ==')
  const noRemote = runScript(['--token', TOKEN])
  check('it says nothing will be pushed', /no --remote given/.test(noRemote.out))
  check('it does not claim to have pushed', !/OK {4}pushed/.test(noRemote.out))
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
}

console.log('')
console.log(failures.length === 0 ? 'PUSH SCRIPT: ALL PASS' : `PUSH SCRIPT: ${failures.length} FAILURE(S) -> ${failures.join('; ')}`)
process.exitCode = failures.length === 0 ? 0 : 1
