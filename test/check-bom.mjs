// Scan $DSH_HOME (and the offload tooling) for BOM contamination and for files
// that DSH would fail to parse. Exits non-zero when a JSON/YAML file carries a
// UTF-8 BOM, because Node's JSON.parse rejects a BOM outright and DSH reads its
// profile manifest with readFileSync(path, 'utf8') + JSON.parse.
//
// Usage: node check-bom.mjs [root...]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const roots = process.argv.slice(2)
if (roots.length === 0) {
  roots.push(process.env.DSH_HOME ?? join(process.env.USERPROFILE, '.dsh'))
  roots.push('F:\\bonsai\\offload-plugin')
}

const DATA_EXT = new Set(['.json', '.yaml', '.yml'])
const CODE_EXT = new Set(['.ps1', '.psm1'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.pnpm'])

const problems = []
const notes = []
let scanned = 0

function walk(dir, depth = 0) {
  if (depth > 6) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(p, depth + 1)
      continue
    }
    if (!e.isFile()) continue
    const ext = extname(e.name).toLowerCase()
    if (!DATA_EXT.has(ext) && !CODE_EXT.has(ext)) continue
    let bytes
    try { bytes = readFileSync(p) } catch { continue }
    scanned++
    const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf

    if (DATA_EXT.has(ext)) {
      if (hasBom) {
        problems.push({ p, kind: 'BOM in data file', fatal: ext === '.json' })
      }
      // Reproduce exactly what the harness does for JSON.
      if (ext === '.json') {
        try { JSON.parse(bytes.toString('utf8')) }
        catch (err) { problems.push({ p, kind: `JSON.parse fails: ${err.message.slice(0, 80)}`, fatal: true }) }
      }
      // A stray CRLF is not fatal but is a fingerprint of a PowerShell rewrite.
      const text = bytes.toString('utf8')
      const crlf = (text.match(/\r\n/g) ?? []).length
      if (crlf > 0) notes.push({ p, kind: `${crlf} CRLF line ending(s)`, fatal: false })
    } else {
      // PowerShell 5.1 reads a BOM-less script as the ANSI codepage, which
      // mangles non-ASCII content; scripts are the one place a BOM is wanted.
      const nonAscii = /[^\x00-\x7F]/.test(bytes.toString('utf8'))
      if (!hasBom && nonAscii) notes.push({ p, kind: 'non-ASCII but no BOM (PS 5.1 may misread)', fatal: false })
    }
  }
}

for (const root of roots) {
  try { if (statSync(root).isDirectory()) walk(root) } catch { console.log(`skipped (not found): ${root}`) }
}

console.log(`scanned ${scanned} file(s) under: ${roots.join(', ')}`)
for (const n of notes) console.log(`  note  ${n.kind}  ->  ${n.p}`)
for (const p of problems) console.log(`  ${p.fatal ? 'FATAL' : 'WARN '} ${p.kind}  ->  ${p.p}`)

const fatal = problems.filter((p) => p.fatal)
if (fatal.length === 0 && notes.length === 0) console.log('\nclean: no BOM, no JSON parse failures, no odd line endings')
else if (fatal.length === 0) console.log('\nno fatal problem (notes above are informational)')
else {
  console.log(`\n${fatal.length} FATAL problem(s): DSH will fail to boot until these are fixed`)
  process.exitCode = 1
}
