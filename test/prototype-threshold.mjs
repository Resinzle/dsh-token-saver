// Second measurement: does a relevance threshold plus finer chunks turn the
// two-sided retrieval result into a consistent one?
//
// The first run showed rerank scores that clearly separate "this document
// answers the question" (0.92) from "nothing here does" (0.05), yet the tool
// returned three chunks in both cases -- so an unanswerable query produced
// 24,000 characters of noise while a good one produced a hit. This run measures
// what a threshold and smaller chunks actually do to the delivered size.
//
// Usage (any directory; this script has no third-party dependencies):
//   node <this-repo>/test/prototype-threshold.mjs [corpusRoot]
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseYaml } from '../tools/yaml-min.mjs'

// Derived from this file's own location; see prototype-semantic.mjs for why this
// was once a hardcoded absolute path and why that was wrong.
const LIB = new URL('../lib/', import.meta.url).href
const { loadStore, searchByVector, saveStore } = await import(`${LIB}vector-store.js`)
const { indexTree } = await import(`${LIB}indexer.js`)
const { embed, rerank } = await import(`${LIB}embeddings.js`)

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE, '.dsh')
const settings = parseYaml(readFileSync(join(dshHome, 'settings.yaml'), 'utf8'))
const creds = parseYaml(readFileSync(join(dshHome, '.credentials.yaml'), 'utf8'))
const route = settings['llm-pi-ai'].providers.siliconflow

const client = {
  baseUrl: route.baseURL,
  apiKey: creds.refs[route.apiKeyEnv],
  embeddingModel: 'BAAI/bge-m3',
  rerankModel: 'BAAI/bge-reranker-v2-m3',
  timeoutMs: 120_000,
}

// No sensible default corpus: this measured retrieval over a specific directory
// of package READMEs, and the machine-specific path is gone. Pass a directory or
// set CORPUS_ROOT; a missing argument is reported rather than silently indexing
// nothing. Scratch lives beside the repository so this runs anywhere.
const corpusRoot = process.argv[2] ?? process.env.CORPUS_ROOT
if (!corpusRoot || !existsSync(corpusRoot)) {
  console.error('usage: node test/prototype-threshold.mjs <corpusRoot>')
  console.error(`  corpusRoot ${corpusRoot ? `does not exist: ${corpusRoot}` : 'is required (or set CORPUS_ROOT)'}`)
  process.exit(2)
}
const scratch = join(dirname(fileURLToPath(import.meta.url)), '..', '.semantic-prototype')
if (!existsSync(scratch)) mkdirSync(scratch, { recursive: true })
const storePath = join(scratch, 'vectors.json')

// Finer chunks: 60-line windows were returning more context than the task needs.
const LINES = Number(process.env.CHUNK_LINES ?? 25)
const OVERLAP = Number(process.env.CHUNK_OVERLAP ?? 5)
const THRESHOLD = Number(process.env.RERANK_THRESHOLD ?? 0.3)

const store = loadStore(storePath, client.embeddingModel)
console.log(`chunk size: ${LINES} lines, overlap ${OVERLAP}`)
const t0 = Date.now()
const built = await indexTree(client, store, storePath, corpusRoot, {
  maxFileBytes: 256 * 1024,
  lines: LINES,
  overlap: OVERLAP,
  batchSize: 16,
  maxFiles: 120,
})
console.log(`index: ${built.indexed.length} files, chunks in store ${store.chunks.length}, ${built.tokens.toLocaleString()} embed tokens, ${((Date.now() - t0) / 1000).toFixed(1)}s\n`)

// Ground truth: which file should answer each question, and which should NOT.
const cases = [
  { q: 'how do I stop a huge tool result from filling up the context window', expect: /spill|pruner|compaction/i },
  { q: 'what makes a DSH profile fail to load at startup', expect: /app-boot|profile/i },
  { q: 'how are session files persisted and where are they stored', expect: /session-persistence|session-format/i },
  { q: 'how does a subagent inherit the parent conversation', expect: /subagent|session/i },
  { q: 'what controls whether the model can write files', expect: /fs-sandbox|sandbox|permission/i },
  // A question this corpus cannot answer, to see whether a threshold refuses it.
  { q: 'what is the melting point of tungsten in kelvin', expect: null },
]

let keptTotals = []
console.log('query'.padEnd(52) + 'topScore  kept  chars   verdict')
for (const c of cases) {
  const { vectors } = await embed(client, [c.q])
  const candidates = searchByVector(store, vectors[0], 12)
  const ranked = await rerank(client, c.q, candidates.map((x) => x.text), 12)
  const scored = ranked
    ? ranked.map((r) => ({ ...candidates[r.index], score: r.score })).sort((a, b) => b.score - a.score)
    : candidates.map((x) => ({ ...x, score: x.vectorScore }))

  const top = scored[0]
  const kept = THRESHOLD > 0 ? scored.filter((s) => s.score >= THRESHOLD).slice(0, 3) : scored.slice(0, 3)
  const chars = kept.reduce((a, s) => a + s.text.length, 0)
  keptTotals.push(chars)

  const hitExpected = c.expect ? kept.some((s) => c.expect.test(s.file)) : null
  const verdict = c.expect === null
    ? (kept.length === 0 ? 'correctly refused' : `returned ${kept.length} anyway`)
    : (hitExpected ? 'correct file' : 'MISS')
  console.log(`${c.q.slice(0, 50).padEnd(52)}${(top?.score ?? 0).toFixed(3).padStart(8)}${String(kept.length).padStart(6)}${String(chars).padStart(7)}   ${verdict}`)

  for (const k of kept) console.log(`      ${k.file}:${k.start}-${k.end}  ${k.score.toFixed(3)}`)
}

const avg = Math.round(keptTotals.reduce((a, b) => a + b, 0) / keptTotals.length)
console.log(`\naverage characters delivered per query: ${avg} (~${Math.round(avg / 2)} tok)`)
console.log(`rerank threshold used: ${THRESHOLD}`)
console.log('\nCompare with the 60-line run, which delivered 14,000-28,000 chars per')
console.log('query regardless of whether the corpus could answer it at all.')
