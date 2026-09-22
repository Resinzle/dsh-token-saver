// Prototype: measure whether semantic retrieval actually beats keyword search
// for the kind of "find the right passage in a pile of docs" work that currently
// costs DeepSeek a lot of context.
//
// This only MEASURES. It builds an index in a scratch directory and compares
// retrieval quality, token cost and latency against `grep`. Nothing is wired
// into the harness until the numbers justify it.
//
// Usage (from the DSH profile directory so harness packages resolve):
//   node <this-repo>/test/prototype-semantic.mjs [corpusRoot] [maxFiles]
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseYaml } from '../tools/yaml-min.mjs'

// Absolute module URLs, derived from this file's own location.
//
// They were once a hardcoded `F:/bonsai/offload-plugin/lib/` path, which made
// the script unusable for anyone else and silently wrong after the checkout
// moved. Resolving relative to `import.meta.url` keeps the same absolute-URL
// behaviour -- which this script needs because it may be run from a directory
// where a relative specifier would not resolve -- without the machine-specific
// constant.
const LIB = new URL('../lib/', import.meta.url).href
const { loadStore, searchByVector, storeStats } = await import(`${LIB}vector-store.js`)
const { indexTree } = await import(`${LIB}indexer.js`)
const { embed, rerank } = await import(`${LIB}embeddings.js`)

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE, '.dsh')
const settings = parseYaml(readFileSync(join(dshHome, 'settings.yaml'), 'utf8'))
const creds = parseYaml(readFileSync(join(dshHome, '.credentials.yaml'), 'utf8'))
const route = settings['llm-pi-ai'].providers.siliconflow
const key = creds.refs[route.apiKeyEnv]

const client = {
  baseUrl: route.baseURL,
  apiKey: key,
  embeddingModel: process.env.EMBED_MODEL ?? 'BAAI/bge-m3',
  rerankModel: process.env.RERANK_MODEL ?? 'BAAI/bge-reranker-v2-m3',
  timeoutMs: 120_000,
}

// The corpus to index. There is no sensible default: this prototype measured
// retrieval over a directory of package READMEs, and that directory's path was
// hardcoded to one machine's npm cache here. Pass the directory you want indexed,
// or set CORPUS_ROOT. A missing argument is reported rather than silently
// indexing nothing.
const corpusRoot = process.argv[2] ?? process.env.CORPUS_ROOT
const maxFiles = Number(process.argv[3] ?? 120)

if (!corpusRoot || !existsSync(corpusRoot)) {
  console.error('usage: node test/prototype-semantic.mjs <corpusRoot> [maxFiles]')
  console.error(`  corpusRoot ${corpusRoot ? `does not exist: ${corpusRoot}` : 'is required (or set CORPUS_ROOT)'}`)
  process.exit(2)
}

// Scratch lives beside the repository rather than on a fixed drive, so the
// prototype is runnable anywhere.
const scratch = join(dirname(fileURLToPath(import.meta.url)), '..', '.semantic-prototype')
const storePath = join(scratch, 'vectors.json')

if (!existsSync(scratch)) mkdirSync(scratch, { recursive: true })

// --- Build the index --------------------------------------------------------
console.log(`corpus: ${corpusRoot}`)
console.log(`store : ${storePath}\n`)

const store = loadStore(storePath, client.embeddingModel)
const t0 = Date.now()
const result = await indexTree(client, store, storePath, corpusRoot, {
  maxFileBytes: 256 * 1024,
  lines: 60,
  overlap: 10,
  batchSize: 16,
  maxFiles: Number(process.env.MAX_FILES ?? 120),
  onProgress: (p) => process.stdout.write(`  indexed ${p.indexed}/${p.total} files, ${p.chunks} chunks, ${p.tokens} embed tokens\r`),
})
const indexSecs = ((Date.now() - t0) / 1000).toFixed(1)
const stats = storeStats(store, storePath)

console.log('\n--- index ---')
console.log(`  candidates scanned : ${result.candidates}`)
console.log(`  newly indexed      : ${result.indexed.length} files`)
console.log(`  unchanged (skipped): ${result.unchanged}`)
console.log(`  skipped            : ${result.skipped.length} (${[...new Set(result.skipped.map((s) => s.reason))].join(', ') || 'none'})`)
console.log(`  chunks in store    : ${stats.chunks} across ${stats.files} files`)
console.log(`  corpus text        : ${(stats.chars / 1e6).toFixed(2)} M chars`)
console.log(`  embed tokens spent : ${result.tokens.toLocaleString()}`)
console.log(`  index wall clock   : ${indexSecs}s`)
console.log(`  store size on disk : ${(stats.bytes / 1024).toFixed(0)} KB`)

// --- Queries ----------------------------------------------------------------
const queries = [
  'how do I stop a huge tool result from filling up the context window',
  'what makes a DSH profile fail to load at startup',
  'rate limiting and how many requests per minute are allowed',
  'how are session files persisted and where are they stored',
  'how does a subagent inherit the parent conversation',
  'what controls whether the model can write files',
]

const TOP_K = 3
let embedTokensForQueries = 0
let totalSemanticChars = 0
let totalSemanticMs = 0
let totalRerankMs = 0

console.log('\n--- retrieval comparison (top 3 by default) ---')
for (const q of queries) {
  console.log(`\nQ: ${q}`)

  // Semantic
  const qs = Date.now()
  const { vectors, tokens } = await embed(client, [q])
  embedTokensForQueries += tokens
  const candidates = searchByVector(store, vectors[0], 12)
  const ranked = await rerank(client, q, candidates.map((c) => c.text), TOP_K)
  const semMs = Date.now() - qs
  totalSemanticMs += semMs

  const final = ranked
    ? ranked.map((r) => ({ ...candidates[r.index], rerankScore: r.score }))
    : candidates.slice(0, TOP_K)
  const semChars = final.reduce((a, c) => a + c.text.length, 0)
  totalSemanticChars += semChars

  console.log(`  semantic (${semMs}ms, ${semChars} chars ~${Math.round(semChars / 2)} tok):`)
  for (const c of final) {
    const tag = c.rerankScore !== undefined ? `rerank=${c.rerankScore.toFixed(3)}` : `cos=${c.vectorScore.toFixed(3)}`
    console.log(`    ${c.file}:${c.start}-${c.end}  ${tag}`)
  }

  // Keyword baseline: what `grep` would hand back for the same intent.
  const words = q.split(/\s+/).filter((w) => w.length > 3).slice(0, 4)
  const kw = Date.now()
  const matches = []
  for (const c of store.chunks) {
    const hit = words.some((w) => c.text.toLowerCase().includes(w.toLowerCase()))
    if (hit) matches.push(c)
    if (matches.length >= 200) break
  }
  const kwMs = Date.now() - kw
  const kwChars = matches.slice(0, TOP_K).reduce((a, c) => a + c.text.length, 0)
  console.log(`  keyword  (${kwMs}ms, ${matches.length} chunks match, top3 = ${kwChars} chars ~${Math.round(kwChars / 2)} tok)`)
  for (const c of matches.slice(0, TOP_K)) console.log(`    ${c.file}:${c.start}-${c.end}`)
}

console.log('\n--- totals ---')
const corpusTokens = Math.round(stats.chars / 2)
console.log(`  whole corpus read into context : ~${corpusTokens.toLocaleString()} tok (${(stats.chars / 1e6).toFixed(2)} M chars)`)
console.log(`  one semantic query returns     : ~${Math.round(totalSemanticChars / queries.length / 2)} tok on average`)
console.log(`  saving per query               : ~${(corpusTokens / Math.max(Math.round(totalSemanticChars / queries.length / 2), 1)).toFixed(0)}x fewer tokens`)
console.log(`  embedding cost to build        : ${result.tokens.toLocaleString()} tok (free tier)`)
console.log(`  query latency                  : ${Math.round(totalSemanticMs / queries.length)}ms average`)
console.log('')
console.log('NOTE: token counts here are estimated at ~2 chars/token, the same coarse')
console.log('      heuristic used elsewhere in this deployment. Treat them as ratios, not')
console.log('      billing figures.')
