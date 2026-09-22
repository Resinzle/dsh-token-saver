/**
 * A local vector store for retrieval over files.
 *
 * Design constraints that shaped it:
 *
 *  - **No new dependency.** Vectors are stored as plain JSON and compared with a
 *    linear cosine scan. At the scale this is built for (hundreds to a few
 *    thousand chunks under a workspace) that is a few milliseconds, so a native
 *    vector index would add an install step and a failure mode for nothing.
 *  - **Chunks carry their location**, so a hit can be followed up with an exact
 *    `read offset/limit` when the surrounding lines matter.
 *  - **The model identity is recorded.** A different embedding model produces a
 *    different vector space; comparing across them silently returns noise, so a
 *    model mismatch invalidates the index instead.
 *
 * @module local-offload/vector-store
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { cosine } from './embeddings.js'

/** Bump when the persisted layout changes. */
const STORE_VERSION = 1

/**
 * Read a store, or return an empty one.
 *
 * A corrupt or version-mismatched file is reported as empty rather than thrown:
 * the store is derived data that can always be rebuilt, and refusing to start
 * because a cache went bad is worse than rebuilding it.
 */
export function loadStore(path, embeddingModel) {
  if (!existsSync(path)) return { version: STORE_VERSION, model: embeddingModel, chunks: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed?.version !== STORE_VERSION || parsed?.model !== embeddingModel) {
      return { version: STORE_VERSION, model: embeddingModel, chunks: [] }
    }
    return { version: STORE_VERSION, model: embeddingModel, chunks: parsed.chunks ?? [] }
  } catch {
    return { version: STORE_VERSION, model: embeddingModel, chunks: [] }
  }
}

/** Persist a store, creating its directory when needed. */
export function saveStore(path, store) {
  mkdirSync(dirname(path), { recursive: true })
  // Six decimals is far more precision than cosine ranking needs, and it keeps
  // the file roughly a third smaller than full float output.
  const compact = {
    version: store.version,
    model: store.model,
    chunks: store.chunks.map((c) => ({
      file: c.file,
      start: c.start,
      end: c.end,
      text: c.text,
      vector: c.vector.map((v) => Math.round(v * 1e6) / 1e6),
    })),
  }
  writeFileSync(path, JSON.stringify(compact), 'utf8')
}

/** Files already indexed, mapped to their recorded content hash. */
export function indexedHashes(store) {
  const map = new Map()
  for (const c of store.chunks) if (!map.has(c.file)) map.set(c.file, c.hash)
  return map
}

/** Drop every chunk belonging to one file. */
export function removeFile(store, file) {
  store.chunks = store.chunks.filter((c) => c.file !== file)
}

/** Query the store, optionally reranking through an external reranker. */
export function searchByVector(store, queryVector, limit) {
  const scored = store.chunks.map((chunk, i) => ({ i, score: cosine(queryVector, chunk.vector) }))
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((s) => ({ ...store.chunks[s.i], vectorScore: s.score }))
}

/** Report what a store holds. */
export function storeStats(store, path) {
  const files = new Set(store.chunks.map((c) => c.file))
  const chars = store.chunks.reduce((a, c) => a + (c.text?.length ?? 0), 0)
  let bytes = 0
  try { bytes = readFileSync(path).length } catch { /* not written yet */ }
  return { files: files.size, chunks: store.chunks.length, chars, bytes, path }
}
