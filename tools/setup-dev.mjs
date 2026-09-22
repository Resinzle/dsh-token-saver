#!/usr/bin/env node
/**
 * setup-dev — make every script in this repository runnable from the checkout,
 * without installing anything.
 *
 * Why this is needed
 * ------------------
 * Most scripts here are self-contained: `tools/doctor.mjs`, `tools/verify-live.mjs`,
 * `test/test-credentials.mjs`, `test/turns-report.mjs` and the cost reports use
 * only `node:` builtins, so they run from anywhere with no setup at all.
 *
 * A few go further and import the plugin **by its package name**
 * (`dsh-plugin-local-offload`) so that they exercise the same resolution DSH
 * uses, rather than reaching into `lib/` by path. That needs a `node_modules`
 * entry, and the harness packages they also import (`@deepseek-ai/dsh-llm-pi-ai`)
 * need one too.
 *
 * Installing those would mean a package manager and a network round trip just to
 * run tests. The harness already provides them, so this script points the
 * checkout at the harness that is already on the machine.
 *
 * What it creates
 * ---------------
 *   node_modules/@deepseek-ai   ->  <DSH profiles>/node_modules/@deepseek-ai
 *   node_modules/dsh-plugin-local-offload  ->  this checkout (a self-link)
 *
 * Both are directories on disk that `node_modules` lookups find, so no
 * administrator rights are required, which a Windows symlink would need.
 *
 * Usage:
 *   node tools/setup-dev.mjs                 # create the links
 *   node tools/setup-dev.mjs --dsh-home DIR
 *   node tools/setup-dev.mjs --status        # report only, change nothing
 *   node tools/setup-dev.mjs --dry-run
 *
 * `node_modules/` is gitignored, so nothing here reaches the repository.
 *
 * @module setup-dev
 */
import { existsSync, readdirSync, symlinkSync, mkdirSync, lstatSync, rmSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const hasFlag = (f) => argv.includes(f)
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const repo = resolve(valueOf('--root', join(dirname(fileURLToPath(import.meta.url)), '..')))
const dshHome = resolve(valueOf('--dsh-home', process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')))
const statusOnly = hasFlag('--status')
const dryRun = hasFlag('--dry-run')
const nodeModules = join(repo, 'node_modules')

/**
 * Where the harness packages live, checked in the order DSH itself would find
 * them: the profile that is actually installed, then the profiles root, then the
 * npx cache that `npx @deepseek-ai/dsh` populates.
 *
 * @returns {{path: string, label: string}|undefined}
 */
function findDeepseekScope() {
  const candidates = []
  for (const profile of listDirs(join(dshHome, 'profiles'))) {
    candidates.push({ path: join(dshHome, 'profiles', profile, 'node_modules', '@deepseek-ai'), label: `profile ${profile}` })
  }
  candidates.push({ path: join(dshHome, 'profiles', 'node_modules', '@deepseek-ai'), label: 'profiles root' })

  const npxCache = join(process.env.LOCALAPPDATA ?? '', 'npm-cache', '_npx')
  for (const entry of listDirs(npxCache)) {
    candidates.push({ path: join(npxCache, entry, 'node_modules', '@deepseek-ai'), label: `npx cache ${entry}` })
  }

  for (const candidate of candidates) {
    if (existsSync(join(candidate.path, 'dsh-tools'))) return candidate
  }
  return undefined
}

/** Directory names under `dir`, or an empty list. */
function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/**
 * Create a directory link.
 *
 * `type: 'junction'` is what makes this work without administrator rights on
 * Windows; on POSIX the argument is ignored and an ordinary symlink is created.
 * A machine that cannot create either is reported rather than half-configured.
 *
 * @returns {{ok: boolean, detail: string}}
 */
function link(target, linkPath) {
  try {
    if (lstatSync(linkPath, { throwIfNoEntry: false })) {
      const existing = lstatSync(linkPath).isSymbolicLink()
      if (existing) return { ok: true, detail: 'already linked' }
      return { ok: false, detail: 'exists and is a real directory; remove it first' }
    }
  } catch { /* not present */ }

  if (dryRun) return { ok: true, detail: `would link -> ${target}` }
  try {
    mkdirSync(dirname(linkPath), { recursive: true })
    symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    return { ok: true, detail: `linked -> ${target}` }
  } catch (error) {
    return { ok: false, detail: `${error.code ?? error.message}` }
  }
}

console.log(`repository : ${repo}`)
console.log(`harness home: ${dshHome}`)
console.log(`mode        : ${statusOnly ? 'status only' : dryRun ? 'dry run' : 'create links'}\n`)

const scope = findDeepseekScope()
const results = []

// 1. The harness packages, so scripts can import them by name.
if (!scope) {
  results.push({ name: '@deepseek-ai', ok: false, detail: 'not found under the harness home; pass --dsh-home, or run DSH once so its packages are installed' })
} else {
  const r = statusOnly
    ? { ok: existsSync(join(nodeModules, '@deepseek-ai', 'dsh-tools')), detail: existsSync(join(nodeModules, '@deepseek-ai', 'dsh-tools')) ? 'present' : 'missing' }
    : link(scope.path, join(nodeModules, '@deepseek-ai'))
  results.push({ name: '@deepseek-ai', ...r, source: scope.label })
}

// 2. A self-link, so `import 'dsh-plugin-local-offload'` resolves to this checkout
//    exactly as DSH resolves it for an installed profile.
const selfLink = join(nodeModules, 'dsh-plugin-local-offload')
const selfResult = statusOnly
  ? { ok: existsSync(join(selfLink, 'package.json')), detail: existsSync(join(selfLink, 'package.json')) ? 'present' : 'missing' }
  : link(repo, selfLink)
results.push({ name: 'dsh-plugin-local-offload (self-link)', ...selfResult, source: relative(repo, repo) || '.' })

// --- report ---------------------------------------------------------------

let failures = 0
for (const r of results) {
  if (!r.ok) failures++
  console.log(`  ${r.ok ? 'OK  ' : 'FAIL'}  ${r.name}${r.source ? `  (from ${r.source})` : ''}  [${r.detail}]`)
}

if (failures === 0) {
  console.log('\nReady. These now resolve from this checkout:')
  console.log('  node test/verify-all.mjs')
  console.log('  node test/test-rotation-live.mjs')
  console.log('  node test/test-siliconflow.mjs')
  console.log('  node test/test-selfheal.mjs')
  console.log('  node test/test-payload-guard.mjs')
} else {
  console.log('\nSome links could not be created. The scripts that use only `node:` builtins')
  console.log('still work without them -- see the README\'s test section for which is which.')
  console.log('\nOn Windows, if linking failed because symlink creation needs a privilege, the')
  console.log('built-in junction command does not. Run these two lines in the repository root:')
  console.log('  cmd /c mklink /J node_modules\\@deepseek-ai "<harness home>\\profiles\\node_modules\\@deepseek-ai"')
  console.log('  cmd /c mklink /J node_modules\\dsh-plugin-local-offload .')
}

process.exitCode = failures === 0 ? 0 : 1
