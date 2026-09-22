#!/usr/bin/env node
/**
 * check-links — verify that every relative Markdown link in the documentation
 * points at a file that exists.
 *
 * This repository carries more documentation than code, and its documentation
 * carries a lot of cross-references: every design decision is linked from the
 * READMEs to `docs/`, from `docs/` to each other, and from the templates to the
 * measurements. A link that rots when a file is renamed is silent -- GitHub
 * renders it as plain text and nothing fails -- which is exactly the kind of
 * defect a zero-dependency checker should catch.
 *
 * It checks relative file links only. Absolute URLs are skipped on purpose: they
 * cannot be verified without network access, and a checker that fails when the
 * network is down is worse than no checker.
 *
 * Usage:
 *   node tools/check-links.mjs
 *   node tools/check-links.mjs --root <dir>
 *
 * Exit code is 1 when any relative link does not resolve.
 *
 * @module check-links
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const root = resolve(valueOf('--root', join(dirname(fileURLToPath(import.meta.url)), '..')))

/**
 * Paths that a published copy legitimately lacks.
 *
 * `.github/workflows/` is the real case: GitHub will not let a personal access
 * token publish anything there without the `workflow` scope, so a repository can
 * be published without it. A link to those files therefore works in a developer's
 * checkout and breaks on every clone -- which is exactly what happened here, and
 * it meant the repository failed the check it ships.
 *
 * `--published` treats this directory as absent, so the failure is reproducible
 * before pushing rather than discovered by whoever clones next.
 */
const published = argv.includes('--published')
const ABSENT_WHEN_PUBLISHED = ['.github/workflows/']

/** Directories never worth walking for documentation. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.github', '_research', '_install-test'])

/**
 * Every Markdown file that ships, excluding dependency and tooling trees.
 *
 * @returns {string[]} absolute paths
 */
function markdownFiles(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      markdownFiles(join(dir, entry.name), out)
    } else if (entry.name.endsWith('.md')) {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

/**
 * Links to skip, with the reason.
 *
 * Each entry is a path fragment matched against the link target. An entry stays
 * here only while it is a deliberate, documented state -- not to silence a real
 * break.
 *
 * Currently empty: the sponsor QR code exists, so nothing here should be missing.
 * The mechanism is kept because a repository can legitimately have such states --
 * an image added after the text, for instance -- and because removing the map
 * would make the next one harder to record honestly than to ignore.
 */
const ALLOWED_MISSING = new Map()

const files = markdownFiles(root)
let checked = 0
const broken = []
const allowed = []

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const raw = match[1].trim()
    // A title suffix (`"..."`) is legal Markdown; drop it before testing.
    const target = raw.split(/\s+/)[0]
    if (target.length === 0) continue
    // Absolute URLs, anchors, and non-file schemes are out of scope.
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue
    if (target.startsWith('#')) continue

    const withoutAnchor = decodeURIComponent(target.split('#')[0])
    if (withoutAnchor.length === 0) continue
    checked++

    // Under --published, a target inside a directory a published copy lacks is
    // reported even though the file exists here.
    const targetRelative = withoutAnchor.replace(/^\.\.\//, '').replace(/^\.\//, '')
    if (published && ABSENT_WHEN_PUBLISHED.some((prefix) => targetRelative.startsWith(prefix))) {
      broken.push({ file, target, why: `absent from a published copy (${targetRelative})` })
      continue
    }

    const resolved = resolve(dirname(file), withoutAnchor)
    if (existsSync(resolved) && statSync(resolved).isFile()) continue

    const reason = ALLOWED_MISSING.get(withoutAnchor.replace(/^\.\.\//, ''))
    if (reason) {
      allowed.push({ file, target, reason })
      continue
    }
    broken.push({ file, target })
  }
}

const rel = (p) => p.slice(root.length + 1).replace(/\\/g, '/')

console.log(`checked ${checked} relative link(s) across ${files.length} Markdown file(s) under ${root}`)
for (const a of allowed) console.log(`  ALLOWED  ${rel(a.file)} -> ${a.target}  [${a.reason}]`)

if (broken.length > 0) {
  console.log(`\n${broken.length} broken relative link(s):`)
  for (const b of broken) console.log(`  BROKEN   ${rel(b.file)} -> ${b.target}`)
  console.log('\nFix the link, or add the target. Do not add an ALLOWED_MISSING entry')
  console.log('unless the missing file is a documented state of the repository.')
  process.exitCode = 1
} else {
  console.log('\nALL LINKS RESOLVE')
}
