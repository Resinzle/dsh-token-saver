#!/usr/bin/env node
/**
 * doctor — check whether this setup still applies to the DSH installation on
 * this machine, after a harness upgrade or at any other time.
 *
 * Why this file has no dependencies
 * ---------------------------------
 * The acceptance script this project started with (`test/verify-all.mjs`) imports
 * harness packages by bare specifier (`@deepseek-ai/dsh-llm-pi-ai`, and the plugin
 * by name). Node resolves a bare specifier relative to the importing FILE,
 * walking up its directory tree -- not relative to the current working directory.
 * So a script living outside the DSH installation's own `node_modules` tree cannot
 * import them at all:
 *
 *     $ cd ~/.dsh/profiles/web
 *     $ node <repo>/test/verify-all.mjs
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-llm-pi-ai'
 *
 * That is reproducible on the development machine, and it makes such a script
 * useless as a post-upgrade self-check. This one therefore reads files as data and
 * uses only `node:fs` and `node:path`, so it runs from anywhere. (It also used to
 * fail on `js-yaml`; that dependency is gone from the whole repository, which now
 * reads YAML with `tools/yaml-min.mjs`.)
 *
 * What it cannot check without the harness packages is whether `ctx.tools.register`
 * still accepts the definition at runtime. `tools/verify-live.mjs` covers that
 * without needing them, and `test/verify-all.mjs` does the richer end-to-end pass
 * -- run `node tools/setup-dev.mjs` once to make its bare imports resolve.
 *
 * Usage:
 *   node tools/doctor.mjs
 *   node tools/doctor.mjs --dsh-home "C:\Users\you\.dsh" --profile web
 *   node tools/doctor.mjs --source "F:\path\to\source-checkout"
 *   node tools/doctor.mjs --strict        # treat warnings as failures too
 *   node tools/doctor.mjs --json
 *
 * Exit code is 0 when no check FAILED, and 1 otherwise. Warnings alone do not
 * fail the run unless `--strict` is given. `--strict` is what CI uses, so that a
 * check silently degrading from PASS to WARN cannot pass unnoticed.
 *
 * @module doctor
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// --- output ----------------------------------------------------------------

const argv = process.argv.slice(2)
const hasFlag = (f) => argv.includes(f)
const valueOf = (f, fallback) => {
  const i = argv.indexOf(f)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const asJson = hasFlag('--json')
const strict = hasFlag('--strict')
const results = []

/**
 * Record one check.
 *
 * @param {'PASS'|'WARN'|'FAIL'|'INFO'} level
 * @param {string} title
 * @param {string} [detail]
 */
function report(level, title, detail = '') {
  results.push({ level, title, detail })
  if (asJson) return
  if (level === 'INFO') {
    console.log(`        ${title}${detail ? `  ${detail}` : ''}`)
    return
  }
  const mark = level === 'PASS' ? 'PASS' : level === 'WARN' ? 'WARN' : 'FAIL'
  console.log(`  ${mark}  ${title}${detail ? `  [${detail}]` : ''}`)
}

function section(title) {
  if (!asJson) console.log(`\n== ${title} ==`)
}

// --- locations -------------------------------------------------------------

const dshHome = resolve(valueOf('--dsh-home', process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')))
const profileName = valueOf('--profile', 'web')
const profileDir = join(dshHome, 'profiles', profileName)
const sourceDir = resolve(valueOf('--source', join(dirname(fileURLToPath(import.meta.url)), '..')))

/** Read and parse a JSON file, returning undefined instead of throwing. */
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
}

/**
 * Detect a UTF-8 BOM, which DSH cannot survive in a profile manifest.
 *
 * @returns {boolean} true when the file starts with EF BB BF.
 */
function hasBom(path) {
  try { return readFileSync(path)[0] === 0xef && readFileSync(path)[1] === 0xbb && readFileSync(path)[2] === 0xbf } catch { return false }
}

/**
 * Read one named credential out of the harness's own credential file.
 *
 * Deliberately duplicated from the plugin rather than imported from it: this
 * script must keep working even when the plugin is broken, uninstalled, or
 * absent, since diagnosing that is its job. Only the single requested name is
 * ever read, and the value is never printed -- only its length.
 *
 * @returns {string|undefined}
 */
function readCredentialName(path, ref) {
  if (!path || !ref) return undefined
  try {
    const text = readFileSync(path, 'utf8')
    const refsStart = text.search(/^refs:\s*$/m)
    const scope = refsStart === -1 ? text : text.slice(refsStart)
    const match = new RegExp(`^[ \\t]+${ref}\\s*:\\s*(.+?)\\s*$`, 'm').exec(scope)
    if (!match) return undefined
    const value = match[1].replace(/^['"]|['"]$/g, '')
    return value.length > 0 && !value.includes('REPLACE_WITH_YOUR') ? value : undefined
  } catch {
    return undefined
  }
}

/** Recursively list files under a directory, or an empty list when absent. */
function listFiles(root, prefix = '', out = []) {
  let entries
  try { entries = readdirSync(prefix ? join(root, prefix) : root, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) listFiles(root, rel, out)
    else out.push(rel)
  }
  return out
}

// --- 1. the harness installation ------------------------------------------

section('1. harness installation')

/**
 * Candidate locations for an installed DSH, in order of confidence.
 *
 * The npx cache is checked because `npx @deepseek-ai/dsh` installs the harness
 * into `_npx/<hash>/node_modules` rather than a global prefix, which is where
 * the development machine's copy lived and why a plain `npm root -g` misses it.
 */
function findHarnessRoot() {
  const candidates = []
  const fromEnv = process.env.DSH_INSTALL_ROOT
  if (fromEnv) candidates.push(fromEnv)

  // A profile's node_modules can resolve the harness through a parent directory.
  let dir = profileDir
  for (let i = 0; i < 6; i++) {
    candidates.push(join(dir, 'node_modules'))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  const npxCache = join(process.env.LOCALAPPDATA ?? '', 'npm-cache', '_npx')
  try {
    for (const entry of readdirSync(npxCache, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(join(npxCache, entry.name, 'node_modules'))
    }
  } catch { /* no npx cache */ }

  for (const base of candidates) {
    const manifest = join(base, '@deepseek-ai', 'dsh', 'package.json')
    if (existsSync(manifest)) return { base, manifest, version: readJson(manifest)?.version }
  }
  return undefined
}

const harness = findHarnessRoot()
if (!harness) {
  report('WARN', 'no installed harness found', 'pass --dsh-home, or set DSH_INSTALL_ROOT to the directory containing node_modules')
} else {
  report('PASS', 'harness found', harness.base)
  report('INFO', `harness version: ${harness.version ?? 'unknown'}`)
  if (typeof harness.version === 'string') {
    const [major, minor] = harness.version.split('.').map(Number)
    const isVerifiedFloor = major === 0 && minor === 1
    const isAlpha = /alpha/.test(harness.version)
    if (isAlpha) {
      report('WARN', 'running an alpha build', `${harness.version} — this setup is verified against 0.1.5-rc.2 and later RCs, not alphas`)
    } else if (!isVerifiedFloor) {
      report('WARN', 'version outside the verified range', `${harness.version} — see docs/compatibility.md`)
    } else {
      report('PASS', 'version is in the verified 0.1.x line', harness.version)
    }
  }
}

const dshTools = harness ? join(harness.base, '@deepseek-ai', 'dsh-tools') : undefined
const schemastery = harness ? join(harness.base, '@deepseek-ai', 'schemastery') : undefined

// --- 2. the two public interfaces -----------------------------------------

section('2. public interfaces the plugin uses')

for (const [label, dir] of [['@deepseek-ai/dsh-tools', dshTools], ['@deepseek-ai/schemastery', schemastery]]) {
  if (!dir) { report('WARN', `${label}: cannot check`, 'no harness root'); continue }
  const manifest = readJson(join(dir, 'package.json'))
  if (!manifest) { report('FAIL', `${label} is not installed`, dir); continue }
  report('PASS', `${label} resolves`, `${manifest.name}@${manifest.version}`)
}

if (dshTools) {
  const typesPath = join(dshTools, 'lib', 'types', 'schema.d.ts')
  let typesText
  try { typesText = readFileSync(typesPath, 'utf8') } catch { /* missing */ }

  if (!typesText) {
    report('WARN', 'defineTool declaration not found', typesPath)
  } else {
    report(/export declare function defineTool/.test(typesText)
      ? 'PASS' : 'FAIL',
    'defineTool is exported',
    'dsh-tools/lib/types/schema.d.ts')

    /**
     * Option names the plugin passes to `defineTool`.
     *
     * A rename here is a loud failure: the plugin throws at load. The check is
     * that each name still appears as a required or optional member of the
     * options interface, not that the interface is byte-identical.
     *
     * Members are declared two ways and both occur in the shipped declaration:
     * as properties (`readonly timeoutMs?: number`) and as methods
     * (`isConcurrencySafe?(args): boolean`, `execute(args, exec): Promise<...>`).
     * An earlier version of this check only matched the property form and
     * reported the two methods as missing, which is the failure a self-check
     * must not have.
     */
    const optionBlock = /export interface DefineToolOptions<[^>]*>\s*\{([\s\S]*?)\n\}/.exec(typesText)?.[1] ?? ''
    if (optionBlock.length === 0) {
      report('WARN', 'could not read the DefineToolOptions member list', typesPath)
    }
    const pluginOptions = ['name', 'description', 'parameters', 'output', 'timeoutMs', 'isConcurrencySafe', 'execute']
    const missing = pluginOptions.filter((opt) => {
      const declaration = new RegExp(`(^|\\s)(readonly\\s+)?${opt}\\??\\s*[:(<]`)
      return !declaration.test(optionBlock)
    })
    report(missing.length === 0 ? 'PASS' : 'FAIL',
      'every defineTool option the plugin passes still exists',
      missing.length === 0 ? pluginOptions.join(', ') : `missing: ${missing.join(', ')}`)
  }
}

// --- 3. the four configuration rows ---------------------------------------

section('3. configuration rows the patch targets')

const ROWS = [
  { id: 'session-title-llm', note: 'routes session titles off the paid API' },
  { id: 'spill-policy', note: 'keeps oversized tool output out of context' },
  { id: 'session-query-sqlite', note: 'makes the session search index durable' },
  { id: 'local-offload', note: 'the delegation tool, inserted by this plugin' },
]

/** Every bundle patch and profile patch that could define or disable a row. */
function collectPatchFiles() {
  const files = []
  const profileManifestPath = join(profileDir, 'package.json')
  const manifest = readJson(profileManifestPath)
  const bundleNames = manifest?.dsh?.profile?.bundles ?? []

  for (const bundle of bundleNames) {
    if (!harness) continue
    const patch = join(harness.base, ...bundle.split('/'), 'cordis.patch.yml')
    if (existsSync(patch)) files.push({ path: patch, owner: bundle })
  }
  for (const name of ['cordis.patch.yml', 'cordis.yml']) {
    const path = join(profileDir, name)
    if (existsSync(path)) files.push({ path, owner: `profile:${name}` })
  }
  const homePatch = join(dshHome, 'cordis.patch.yml')
  if (existsSync(homePatch)) files.push({ path: homePatch, owner: 'home:cordis.patch.yml' })
  return files
}

const patchFiles = collectPatchFiles()
if (patchFiles.length === 0) {
  report('WARN', 'no patch files found to inspect', profileDir)
} else {
  report('INFO', `inspecting ${patchFiles.length} patch file(s)`)

  // Read each patch once, then answer both questions from those texts: whether
  // every row still exists, and which layer defines it. A row legitimately
  // appears in several layers (the base bundle defines it, the web bundle may
  // redefine it, the profile patch overrides it), so the per-layer listing is
  // reported as one line per row rather than one per file.
  const patches = []
  for (const { path, owner } of patchFiles) {
    try { patches.push({ owner, text: readFileSync(path, 'utf8') }) } catch { /* unreadable */ }
  }

  const defines = (text, id) => new RegExp(`(^|\\s)-?\\s*id:\\s*['"]?${id}['"]?\\s*$`, 'm').test(text)
  const disables = (text, id) => new RegExp(`id:\\s*['"]?${id}['"]?[\\s\\S]{0,400}?disabled:\\s*true`).test(text)

  const absent = []
  for (const row of ROWS) {
    const owners = patches.filter((p) => defines(p.text, row.id)).map((p) => p.owner)
    if (owners.length === 0) { absent.push(row.id); continue }
    const disabledIn = patches.filter((p) => defines(p.text, row.id) && disables(p.text, row.id)).map((p) => p.owner)
    const isDisabled = disabledIn.length === owners.length
    report(isDisabled ? 'WARN' : 'PASS',
      `${row.id} exists`,
      `${owners.join(', ')}${isDisabled ? ' — but every definition is disabled: true, so a by-id patch will not take effect' : ` — ${row.note}`}`)
  }
  if (absent.length > 0) {
    report('FAIL', 'row ids not found in any inspected patch', absent.join(', '))
    report('INFO', 'a renamed row means that patch is a silent no-op; see docs/compatibility.md')
  } else {
    report('PASS', 'all four row ids still exist in the installed bundles')
  }
}

// --- 4. the profile's own patch values ------------------------------------

section('4. profile patch values')

const profilePatchPath = join(profileDir, 'cordis.patch.yml')
if (!existsSync(profilePatchPath)) {
  report('WARN', 'profile cordis.patch.yml not found', profilePatchPath)
} else {
  const patch = readFileSync(profilePatchPath, 'utf8')
  const expectations = [
    ['spill cap lowered below the shipped 50 KB', /maxInlineBytes:\s*(\d+)/, (m) => Number(m[1]) < 50000],
    ['a delegation endpoint is configured', /id:\s*['"]?local-offload['"]?[\s\S]{0,600}?baseUrl:/, () => true],
    ['a rotation chain is configured', /chain:\s*>?-?/, () => true],
    ['session titles are routed off the paid API', /id:\s*['"]?session-title-llm['"]?[\s\S]{0,600}?provider:/, () => true],
    ['the session search index is durable', /session-search\.db|openAt:\s*(first-search|startup)/, () => true],
  ]
  for (const [label, pattern, predicate] of expectations) {
    const match = pattern.exec(patch)
    report(match && predicate(match) ? 'PASS' : 'WARN', label, match ? match[0].slice(0, 60) : 'pattern not found')
  }
}

// --- 4b. does the delegated credential actually resolve? -------------------
//
// This is the check that would have caught the shipped bug. The plugin used to
// read only `process.env[apiKeyEnv]`, while the harness keeps saved keys in
// `.credentials.yaml` and never exports them -- so a hosted delegation returned
// HTTP 401 for every user who saved a key the documented way, and nothing in the
// logs said why. A wrong answer here is FAIL, not WARN: the delegation cannot
// work, and that is the plugin's entire purpose.

section('4b. delegation credential')

if (!existsSync(profilePatchPath)) {
  report('WARN', 'cannot check the delegated credential without a profile patch', profilePatchPath)
} else {
  const patch = readFileSync(profilePatchPath, 'utf8')
  const offloadBlock = /id:\s*['"]?local-offload['"]?([\s\S]*?)(?=\n\s*-\s*id:|\s*$)/.exec(patch)?.[1] ?? ''
  const refName = /apiKeyEnv:\s*['"]?([A-Za-z0-9_]+)['"]?/.exec(offloadBlock)?.[1]
  const baseUrl = /baseUrl:\s*['"]?(\S+?)['"]?\s*$/m.exec(offloadBlock)?.[1]
  const requestedFile = /credentialsFile:\s*(.+)$/m.exec(offloadBlock)?.[1]?.trim()

  if (!refName) {
    report('INFO', 'no apiKeyEnv is configured for the delegation endpoint',
      'fine for a local endpoint, which ignores the bearer value')
  } else {
    const fromEnv = process.env[refName]
    // `!!js dshHomePath(...)` cannot be evaluated here, so anything that is not a
    // plain path falls back to the default location.
    const credPath = !requestedFile || requestedFile.startsWith('!!') || requestedFile === "''" || requestedFile === '""'
      ? join(dshHome, '.credentials.yaml')
      : resolve(requestedFile.replace(/^['"]|['"]$/g, ''))
    const fromFile = readCredentialName(credPath, refName)

    if (fromEnv) {
      report('PASS', `${refName} resolves from the launch environment`, `${fromEnv.length} chars`)
    } else if (fromFile) {
      report('PASS', `${refName} resolves from the credential file`, `${credPath} (${fromFile.length} chars)`)
    } else {
      report('FAIL', `${refName} resolves nowhere`,
        `not in the environment and not in ${credPath}`)
      report('INFO', 'a hosted delegation will answer HTTP 401 until the key is saved in the DSH Models page or exported; see docs/troubleshooting.md')
    }
    report('INFO', `delegation endpoint: ${baseUrl ?? 'unknown'}`)
  }
}

// --- 5. the installed plugin copy -----------------------------------------

section('5. installed plugin copy')

const installedDir = join(profileDir, 'node_modules', 'dsh-plugin-local-offload')
if (!existsSync(installedDir)) {
  report('WARN', 'plugin is not installed in this profile', installedDir)
  report('INFO', `install with: dsh plugin --profile ${profileName} add ${sourceDir}`)
} else {
  // A `file:` install is a copy, so source edits need a reinstall; a symlink is
  // not detectable here without `lstat` on every entry, so the byte comparison
  // below answers the question that actually matters either way.
  const sourceManifest = readJson(join(sourceDir, 'package.json'))
  const installedManifest = readJson(join(installedDir, 'package.json'))
  report(installedManifest?.version ? 'PASS' : 'WARN', 'installed plugin declares a version', String(installedManifest?.version ?? 'unknown'))

  const relFiles = listFiles(sourceDir, 'lib').concat(['cordis.yml', 'package.json']).filter((rel) => existsSync(join(sourceDir, rel)))
  const differing = []
  for (const rel of relFiles) {
    try {
      if (!readFileSync(join(sourceDir, rel)).equals(readFileSync(join(installedDir, rel)))) differing.push(rel)
    } catch { differing.push(`${rel} (missing)` ) }
  }
  report(differing.length === 0 ? 'PASS' : 'WARN',
    'installed copy is byte-identical to this source checkout',
    differing.length === 0 ? `${relFiles.length} files` : `differs: ${differing.join(', ')} — reinstall and restart DSH`)

  if (sourceManifest && installedManifest && sourceManifest.name !== installedManifest.name) {
    report('FAIL', 'package name changed', `${sourceManifest.name} vs ${installedManifest.name} — the profile manifest references the old name`)
  }
}

// --- 6. the dependency-surface audit --------------------------------------

section('6. dependency surface')

/**
 * Bare specifiers the plugin imports, read from its own source.
 *
 * The claim this project makes is that it imports exactly two packages and no
 * harness-internal module. That claim is only worth anything if it is checked
 * rather than asserted, so it is checked here, against the shipped files.
 */
const libFiles = listFiles(sourceDir, 'lib').filter((f) => f.endsWith('.js'))
const bareImports = new Set()
for (const rel of libFiles) {
  let text
  try { text = readFileSync(join(sourceDir, rel), 'utf8') } catch { continue }
  for (const match of text.matchAll(/^\s*(?:import|export)[\s\S]*?from\s+['"]([^'".][^'"]*)['"]/gm)) {
    const specifier = match[1]
    if (specifier.startsWith('node:')) continue
    bareImports.add(specifier)
  }
}
const allowed = new Set(['@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery'])
const unexpected = [...bareImports].filter((s) => !allowed.has(s))
report(unexpected.length === 0 ? 'PASS' : 'FAIL',
  `plugin imports only public packages (${bareImports.size})`,
  [...bareImports].sort().join(', '))
if (unexpected.length > 0) report('FAIL', 'unexpected import(s)', unexpected.join(', '))

const sourceManifest = readJson(join(sourceDir, 'package.json'))
const declaredPeers = Object.keys(sourceManifest?.peerDependencies ?? {})
const unusedPeers = declaredPeers.filter((p) => !bareImports.has(p))
report(unusedPeers.length === 0 ? 'PASS' : 'WARN',
  'every declared peerDependency is actually imported',
  unusedPeers.length === 0 ? declaredPeers.join(', ') : `declared but unused: ${unusedPeers.join(', ')}`)

// --- 7. the encoding hazard ------------------------------------------------

section('7. encoding guard')

/**
 * Scan `$DSH_HOME` for the two damage patterns that break DSH startup.
 *
 * A UTF-8 BOM in a `.json` file makes `JSON.parse` throw, and DSH reads profile
 * manifests that way, so this failure is unrecoverable without manual repair.
 * A `.json` file that is not parseable is reported separately because the two
 * have different causes.
 */
const scanRoots = [dshHome]
const bomFiles = []
const badJson = []
let scanned = 0
for (const root of scanRoots) {
  for (const rel of listFiles(root)) {
    if (!/\.json$/.test(rel)) continue
    if (rel.includes('node_modules/')) continue
    const path = join(root, rel)
    scanned++
    if (hasBom(path)) bomFiles.push(rel)
    else if (readJson(path) === undefined) badJson.push(rel)
  }
}
report(bomFiles.length === 0 ? 'PASS' : 'FAIL',
  `no UTF-8 BOM in ${scanned} JSON file(s) under ${dshHome}`,
  bomFiles.length === 0 ? '' : bomFiles.slice(0, 5).join(', '))
if (badJson.length > 0) {
  report('WARN', 'unparseable JSON files', `${badJson.slice(0, 5).join(', ')} — not BOM-related; DSH may fail to read these`)
}

// --- 7b. the opposite rule: a Chinese .ps1 MUST have a BOM -----------------
//
// The two rules point in opposite directions and both are real:
//   .json  -> must NOT have a BOM (JSON.parse rejects it)
//   .ps1   -> MUST have a BOM when it contains non-ASCII, or Windows
//             PowerShell 5.1 reads it as GBK, mangles the text, and can fail to
//             parse the file at all
//
// This is not hypothetical. While removing the launcher's auto-start, an edit
// stripped the BOM from `dsh-launcher.ps1`; the parser then reported
// "The string is missing the terminator: '" and the launcher stopped working.
// Restoring the BOM fixed it immediately. Nothing checked for this, so it is
// checked here.
//
// The scan covers the harness home and, when it is known, the directory holding
// the DSH launcher, because that file lives outside `$DSH_HOME` on this machine.
const scriptRoots = [dshHome]
const launcherOverride = process.env.DSH_LAUNCHER
if (launcherOverride && existsSync(launcherOverride)) scriptRoots.push(dirname(launcherOverride))

const bomlessScripts = []
let scriptsScanned = 0
for (const root of scriptRoots) {
  for (const rel of listFiles(root)) {
    if (!/\.ps1$/i.test(rel)) continue
    if (rel.includes('node_modules/')) continue
    scriptsScanned++
    const path = join(root, rel)
    let bytes
    try { bytes = readFileSync(path) } catch { continue }
    const nonAscii = bytes.some((b) => b > 0x7f)
    const hasBomBytes = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    if (nonAscii && !hasBomBytes) bomlessScripts.push(rel)
  }
}
if (scriptsScanned === 0) {
  report('INFO', 'no .ps1 scripts found to check for the BOM rule', scriptRoots.join(', '))
} else {
  report(bomlessScripts.length === 0 ? 'PASS' : 'FAIL',
    `${scriptsScanned} PowerShell script(s) with non-ASCII text all carry a BOM`,
    bomlessScripts.length === 0
      ? ''
      : `${bomlessScripts.slice(0, 3).join(', ')} — Windows PowerShell 5.1 will read these as GBK`)
  if (bomlessScripts.length > 0) {
    report('INFO', 'fix by prepending EF BB BF, written through Node rather than PowerShell',
      "node -e \"const fs=require('node:fs');const p=process.argv[1];const t=fs.readFileSync(p,'utf8');if(t.charCodeAt(0)!==0xFEFF)fs.writeFileSync(p,'\\uFEFF'+t,'utf8')\" <file>")
  }
}

// --- 8. install method -----------------------------------------------------

section('8. install method')

const bundleList = readJson(join(profileDir, 'package.json'))?.dsh?.profile?.bundles ?? []
const bundleInstalled = bundleList.includes('dsh-plugin-local-offload')
report(bundleInstalled ? 'PASS' : 'WARN',
  'plugin is listed in the profile bundle list',
  bundleInstalled ? bundleList.join(', ') : `add it with: dsh plugin --profile ${profileName} add ${sourceDir}`)

const profileManifestPath = join(profileDir, 'package.json')
if (existsSync(profileManifestPath)) {
  const dep = readJson(profileManifestPath)?.dependencies?.['dsh-plugin-local-offload']
  if (typeof dep === 'string') {
    report('INFO', `dependency spec: ${dep}`)
    if (dep.startsWith('file:')) {
      report('INFO', 'a file: dependency is a COPY — source edits need a reinstall plus a DSH restart')
    } else if (dep.startsWith('link:')) {
      report('INFO', 'a link: dependency is a SYMLINK — source edits need only a DSH restart')
    }
  }
}

// --- summary ---------------------------------------------------------------

const failures = results.filter((r) => r.level === 'FAIL')
const warnings = results.filter((r) => r.level === 'WARN')

if (asJson) {
  console.log(JSON.stringify({
    dshHome,
    profile: profileName,
    source: sourceDir,
    harness: harness?.version,
    strict,
    failures: failures.length,
    warnings: warnings.length,
    checks: results,
  }, null, 2))
} else {
  console.log('\n== summary ==')
  const effective = failures.length + (strict ? warnings.length : 0)
  if (effective === 0) {
    console.log('ALL CHECKS PASS')
    console.log(`Runtime details: DSH home ${dshHome}, profile ${profileName}, source ${sourceDir}.`)
  } else {
    if (failures.length > 0) {
      console.log(`${failures.length} FAILURE(S):`)
      for (const f of failures) console.log(`  - ${f.title}${f.detail ? ` (${f.detail})` : ''}`)
    }
    if (warnings.length > 0) {
      console.log(`${warnings.length} WARNING(S)${strict ? ' (fatal under --strict)' : ''}:`)
      for (const w of warnings) console.log(`  - ${w.title}${w.detail ? ` (${w.detail})` : ''}`)
    }
    console.log('\nA FAILURE in section 3 means a config row was renamed and that patch is')
    console.log('now a silent no-op. A FAILURE in section 2 means the plugin will not load.')
    console.log('See docs/compatibility.md for the repair for each case.')
    if (strict && failures.length === 0) {
      console.log('\nNo check failed; --strict turned the warnings above into this exit code.')
    }
  }
  console.log(`\nFor the end-to-end runtime check, run this from the profile directory:`)
  console.log(`  node ${relative(process.cwd(), join(sourceDir, 'test', 'verify-all.mjs'))}`)
  console.log('(that script does import harness packages, so it only resolves when the')
  console.log(' profile directory itself can resolve them; this script has no such limit.)')
}

process.exitCode = failures.length === 0 && !(strict && warnings.length > 0) ? 0 : 1
