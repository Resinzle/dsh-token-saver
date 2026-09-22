#!/usr/bin/env node
/**
 * push-to-github — commit this checkout and push it to a remote.
 *
 * Why this is Node rather than PowerShell
 * ---------------------------------------
 * The first version was a `.ps1`. Two things made Node the better home:
 *
 *  - **Testability.** The credential handling is a security promise -- the user
 *    hands over a token that can write to their account -- and a promise that
 *    cannot be executed in a test is not worth much. This runs identically under
 *    `node`, so `test/test-push-script.mjs` can drive it against a throwaway
 *    remote and assert what lands in `.git/config`.
 *  - **Portability.** A `.ps1` containing non-ASCII must be saved as UTF-8 *with*
 *    a BOM or Windows PowerShell 5.1 reads it as GBK and can fail to parse it.
 *    That failure really happened to this project's launcher. Node has no such
 *    rule: UTF-8 in, UTF-8 out.
 *
 * How the credential is handled
 * -----------------------------
 * A token given with `--token` is written to a file created with mode `0600` in
 * the system temp directory, and git is pointed at it with
 * `-c credential.helper=...` for the duration of ONE command. Consequences,
 * all of them asserted by the test:
 *
 *  - the token never enters `.git/config`
 *  - the helper entry is not persisted, so nothing is left behind
 *  - the file is deleted in a `finally`, so a failed push cleans up too
 *  - the token is never echoed
 *
 * Usage:
 *   node tools/push-to-github.mjs --remote <url> [--token <t>] [--branch main]
 *   node tools/push-to-github.mjs --remote <url> --status     # report only
 *
 * Prefer letting Git Credential Manager hold the token and omitting `--token`.
 *
 * @module push-to-github
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync, unlinkSync, readFileSync, existsSync, openSync, closeSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

// --- arguments -------------------------------------------------------------

const argv = process.argv.slice(2)
const hasFlag = (f) => argv.includes(f)
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const repo = resolve(valueOf('--source', join(dirname(fileURLToPath(import.meta.url)), '..')))
const remote = valueOf('--remote', '')
const branch = valueOf('--branch', 'main')
const token = valueOf('--token', '')
const message = valueOf('--message', '')
const statusOnly = hasFlag('--status')
const debugCredential = hasFlag('--debug-credential')
const tunnelPort = Number(valueOf('--tunnel-port', '18081'))

const step = (n, text) => console.log(`\n[${n}] ${text}`)
const ok = (text) => console.log(`    OK    ${text}`)
const warn = (text) => console.log(`    WARN  ${text}`)
const info = (text) => console.log(`          ${text}`)

/** Run git, returning status and combined output. Never throws. */
function git(args, { cwd = repo, input } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024 })
  return {
    status: result.status,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  }
}

// --- 1. the repository -----------------------------------------------------

step(1, 'checking the working tree')
if (!existsSync(join(repo, '.git'))) {
  console.error(`    FAIL  no git repository at ${repo}`)
  process.exit(2)
}
ok(`repository: ${repo}`)

const status = git(['status', '--porcelain'])
const pending = status.out ? status.out.split('\n').filter(Boolean) : []
if (pending.length > 0) {
  console.log(`    ${pending.length} changed path(s)`)
  for (const line of pending.slice(0, 15)) info(line)
} else {
  ok('nothing pending')
}

// A BOM in a JSON file is the failure that stops DSH from booting.
const bomJson = []
for (const line of pending.map((l) => l.slice(3).trim())) {
  if (!line.endsWith('.json')) continue
  const path = join(repo, line)
  if (!existsSync(path)) continue
  const bytes = readFileSync(path)
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bomJson.push(line)
}
if (bomJson.length > 0) {
  warn(`JSON file(s) start with a UTF-8 BOM, which DSH cannot parse:`)
  for (const f of bomJson) info(f)
  info('fix with: node test/check-bom.mjs  (it reports every file)')
} else {
  ok('no BOM in any changed .json file')
}

if (statusOnly) {
  console.log('\n--status given, stopping here.')
  process.exit(0)
}

// --- 2. commit -------------------------------------------------------------

step(2, 'committing')
if (pending.length > 0) {
  git(['add', '-A'])
  const text = message || `chore: update (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`
  const commit = git(['-c', 'user.name=dsh-token-saver', '-c', 'user.email=noreply@localhost', 'commit', '-m', text])
  if (commit.status !== 0) {
    warn(`commit failed: ${commit.out.split('\n').slice(-2).join(' ')}`)
  } else {
    ok(`committed: ${text}`)
  }
} else {
  ok('nothing to commit')
}

const current = git(['rev-parse', '--abbrev-ref', 'HEAD']).out.trim()
if (current !== branch) {
  info(`renaming branch '${current}' to '${branch}'`)
  git(['branch', '-M', branch])
}
ok(`branch: ${branch}`)

// --- 3. the path to the remote --------------------------------------------

step(3, 'verifying the path to the remote')
const isGitHub = /github\.com/i.test(remote)
const tunnelUrl = `http://127.0.0.1:${tunnelPort}`
let tunnelUp = false
if (isGitHub) {
  const probe = spawnSync(process.execPath, ['-e', `
    const net = require('node:net');
    const s = net.connect(${tunnelPort}, '127.0.0.1');
    s.on('connect', () => { s.destroy(); process.exit(0) });
    s.on('error', () => process.exit(1));
    setTimeout(() => process.exit(1), 2000);
  `], { encoding: 'utf8' })
  tunnelUp = probe.status === 0
  if (tunnelUp) ok(`gh-tunnel is listening on ${tunnelUrl}`)
  else {
    warn('gh-tunnel is not running; assuming direct connectivity')
    info('If DNS for github.com is hijacked to 127.0.0.1 on this machine, start it first:')
    info(`    node "${join(repo, 'tools', 'gh-tunnel.mjs')}" --port ${tunnelPort}`)
  }
}

/**
 * `-c` overrides scoped to this process only.
 *
 * `http.https://github.com.proxy` is scoped to that host, so no other remote is
 * affected. The OpenSSL TLS backend is required on Windows builds of git that
 * default to schannel: through a proxy those fail with
 * `SEC_E_NO_CREDENTIALS`.
 */
const gitOverrides = []
if (isGitHub && tunnelUp) {
  gitOverrides.push('-c', `http.https://github.com.proxy=${tunnelUrl}`, '-c', 'http.sslBackend=openssl')
}

if (remote) {
  info('reading the remote (read-only)')
  const probe = git([...gitOverrides, 'ls-remote', remote])
  if (probe.status !== 0) {
    warn('could not read the remote yet')
    for (const line of probe.out.split('\n').slice(-3)) info(line)
    if (/could not resolve|not found|repository .* not found/i.test(probe.out)) {
      info('The repository may not exist yet. Create it empty, then re-run:')
      info('    https://github.com/new   (do NOT initialise it with a README)')
    }
  } else {
    ok('remote reachable')
  }
} else {
  warn('no --remote given, so nothing will be pushed')
}

// --- 4. credential ---------------------------------------------------------

step(4, token ? 'installing a one-shot credential helper' : 'using existing git credentials')

let tokenFile
/**
 * Quote a path for git's `credential.helper` shell string.
 *
 * Git runs the helper value through `sh`, so a Windows path with backslashes and
 * spaces must survive that. Forward slashes and single quotes around the whole
 * value are enough and avoid escaping rules that differ between platforms.
 */
const forShell = (p) => `'${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`

if (token) {
  tokenFile = join(tmpdir(), `dsh-push-token-${process.pid}-${Date.now()}`)
  const parsed = new URL(remote || (isGitHub ? 'https://github.com' : ''))
  // 0600 where the platform honours it; on Windows the temp directory is already
  // per-user, and that is the real protection here.
  //
  // The FORMAT matters, and both parts of it were wrong in earlier versions:
  //
  //  1. `git credential-store` does not use the `key=value` input format that
  //     `git credential fill` speaks. It stores each credential as ONE URL line.
  //  2. That line is `protocol//user:pass@host/` -- the host appears ONCE, after
  //     the `@`, and there is NOTHING between the `//` and the username. Two
  //     earlier attempts got this wrong and produced respectively
  //     `protocol=...`/`host=...` lines, and `https://github.com/x-access-token:…@github.com`
  //     (host twice). Neither matches, so git falls through to a prompt and the
  //     push dies with "could not read Username" -- which reads like a bad token
  //     and is not one.
  //
  // Verified against a file written by `git credential approve`, which is the
  // authority here: `https://x-access-token:<token>@github.com`.
  //
  // `--debug-credential` prints this line with the password replaced.
  const user = encodeURIComponent('x-access-token')
  const pass = encodeURIComponent(token)
  const fd = openSync(tokenFile, 'w', 0o600)
  writeFileSync(fd, `${parsed.protocol}//${user}:${pass}@${parsed.host}/\n`)
  closeSync(fd)
  try { if ((statSync(tokenFile).mode & 0o777) !== 0o600) { /* windows */ } } catch { /* ignore */ }

  // The EMPTY `credential.helper=` first is essential, not tidiness.
  //
  // Git appends every `credential.helper` value to a list and runs them in order.
  // Without the reset, a machine with Git Credential Manager configured -- the
  // default for Git for Windows, and what an Edge GitHub login sets up -- runs GCM
  // AFTER this helper, finds nothing, and tries to prompt. With no terminal that
  // fails with "could not read Username" and git hangs; on a desktop session it
  // opens a popup. Either way `--token` does not do what it says. Measured on this
  // machine: without the reset, the invocation hung past a 120 s timeout.
  gitOverrides.push('-c', 'credential.helper=', '-c', `credential.helper=store --file=${forShell(tokenFile)}`)
  ok('one-shot helper installed, replacing any configured helper for this one command')
} else {
  info('omit --token only if a credential helper already holds one for this host')
}

// --- 5. push ---------------------------------------------------------------

step(5, remote ? `pushing '${branch}' to ${remote}` : 'skipping the push')
let pushStatus = 0
try {
  if (remote) {
    const remotes = git(['remote']).out.split('\n').filter(Boolean)
    if (remotes.includes('origin')) git(['remote', 'set-url', 'origin', remote])
    else git(['remote', 'add', 'origin', remote])
    ok('origin configured')

    // `--debug-credential` prints the exact helper value and the credential file's
    // state without revealing the token. Reaching for this is legitimate: a helper
    // that works when invoked by hand but not from here is almost always a
    // difference in the quoted argument or the file's contents, and both are
    // invisible from the outside.
    if (debugCredential && tokenFile) {
      const helperValue = gitOverrides[gitOverrides.findIndex((a) => String(a).startsWith('credential.helper=store'))]
      info(`helper value: ${JSON.stringify(helperValue)}`)
      info(`credential file exists: ${existsSync(tokenFile)}`)
      if (existsSync(tokenFile)) {
        const content = readFileSync(tokenFile, 'utf8').trim()
        // The password is between the last ':' and the '@'; replace it.
        info(`credential file shape: ${content.replace(/:([^:@]+)@/, ':<token>@')}`)
        info(`credential file bytes: ${Buffer.byteLength(content, 'utf8')}`)
      }
    }

    const push = git([...gitOverrides, 'push', '-u', 'origin', branch])
    pushStatus = push.status
    for (const line of push.out.split('\n').slice(-8)) {
      // Never print the token, even if git echoed the helper invocation.
      info(token ? line.split(token).join('<token>') : line)
    }
    if (pushStatus === 0) ok('pushed')
    else {
      warn(`push exited with ${pushStatus}`)
      // Diagnose the two failures that do not mean what they look like.
      //
      // Both were met while building this, and both send you looking at the token
      // when the token is fine:
      //
      //  - "could not read Username" / an interactive prompt means the credential
      //    never reached git. That is a helper problem, not a token problem.
      //  - GitHub's workflow-scope refusal is a permission on the TOKEN, and its
      //    wording names the file rather than the fix.
      if (/could not read Username|failed to execute prompt/i.test(push.out)) {
        info('')
        info('The credential never reached git, so this is NOT a bad token.')
        info('git fell through to an interactive prompt. Check, in this order:')
        info('  1. the helper is reset before ours: -c credential.helper= must come first,')
        info('     or a configured Git Credential Manager runs after it and prompts')
        info('  2. the credential file holds ONE URL line: protocol//user:pass@host/')
        info('     (git credential-store does not read the key=value format)')
        info('  3. the host appears exactly once in that line')
        info('Re-run with --debug-credential to print the line with the password redacted.')
      } else if (/without .?workflow.? scope/i.test(push.out)) {
        info('')
        info('The push was AUTHENTICATED and GitHub refused one file, so the token works.')
        info('This repository ships .github/workflows/ci.yml, and a token may not create')
        info('or update workflow files unless it carries the `workflow` scope.')
        info('')
        info('Fix: open https://github.com/settings/tokens, edit the token, and tick')
        info('`workflow` next to `repo`. Then re-run this command unchanged.')
      } else {
        info('403 usually means the token lacks the repo scope, or the repository does not exist.')
        info('401 usually means the token is wrong or expired.')
      }
      info('See docs/troubleshooting.md.')
    }
  }
} finally {
  if (tokenFile) {
    try { unlinkSync(tokenFile); ok('one-shot helper removed') }
    catch { warn(`could not delete ${tokenFile}; remove it by hand`) }
  }
}

// --- 6. next ---------------------------------------------------------------

step(6, 'next')
if (remote) {
  const match = /github\.com[:/]+([^/]+)\/([^/.]+)/.exec(remote)
  if (match) {
    console.log(`    Open:  https://github.com/${match[1]}/${match[2]}`)
    info('Add a description and topics (dsh, deepseek-harness, tokens, llm, cost-optimization).')
  }
}

process.exitCode = pushStatus === 0 ? 0 : 1
