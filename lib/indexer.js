/**
 * Chunk files and embed them into a local vector store.
 *
 * Chunking is the whole game here: too coarse and a "relevant" hit drags in
 * text the model did not need, too fine and the retrieved piece loses the
 * surrounding context that made it meaningful. The defaults are line windows
 * with a small overlap, because line boundaries are cheap to locate exactly and
 * a follow-up `read offset/limit` can always widen a hit.
 *
 * @module local-offload/indexer
 */
import { readFileSync, statSync, readdirSync } from 'node:fs'
import { join, relative, extname, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { embed } from './embeddings.js'
import { indexedHashes, removeFile, saveStore } from './vector-store.js'

/** Directories never worth indexing. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.cache', '__pycache__', '.venv', 'venv', '.idea', '.vscode',
])

/** Text-like extensions worth indexing. */
const TEXT_EXT = new Set([
  '.md', '.txt', '.markdown', '.rst', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.swift', '.sh', '.ps1', '.psm1',
  '.sql', '.html', '.css', '.scss', '.vue', '.svelte', '.lua', '.r', '.pl', '.xml', '.csv',
])

/** One file was skipped, with the reason worth reporting. */
export function shouldIndex(path, maxBytes) {
  const ext = extname(path).toLowerCase()
  if (!TEXT_EXT.has(ext)) return { ok: false, reason: 'not a text extension' }
  let size
  try { size = statSync(path).size } catch { return { ok: false, reason: 'unreadable' } }
  if (size > maxBytes) return { ok: false, reason: `larger than ${Math.round(maxBytes / 1024)} KB` }
  return { ok: true, size }
}

/** Walk a directory, honouring the skip list. */
export function listFiles(root, maxBytes, limit = 5000) {
  const out = []
  const walk = (dir) => {
    if (out.length >= limit) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= limit) return
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(join(dir, e.name))
      } else if (e.isFile()) {
        const p = join(dir, e.name)
        const verdict = shouldIndex(p, maxBytes)
        if (verdict.ok) out.push(p)
      }
    }
  }
  walk(root)
  return out
}

/** Stable content hash, used to skip unchanged files on re-index. */
export function hashText(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

/**
 * Split text into line windows.
 *
 * `overlap` exists so a passage that straddles a boundary is still retrievable
 * whole from one of the two chunks containing it.
 */
export function chunkText(text, { lines = 60, overlap = 10 } = {}) {
  const all = text.split('\n')
  if (all.length <= lines) return [{ start: 1, end: all.length, text }]
  const chunks = []
  const step = Math.max(1, lines - overlap)
  for (let i = 0; i < all.length; i += step) {
    const end = Math.min(i + lines, all.length)
    chunks.push({ start: i + 1, end, text: all.slice(i, end).join('\n') })
    if (end === all.length) break
  }
  return chunks
}

/**
 * Index (or re-index) a directory tree into a store.
 *
 * Incremental by content hash: a file whose text is unchanged is left alone, so
 * a second run costs almost no embedding tokens. That is what makes it practical
 * to re-run after edits rather than treating indexing as a one-off.
 *
 * @returns {Promise<{indexed: string[], skipped: {file: string, reason: string}[], unchanged: number, chunks: number, tokens: number}>}
 */
export async function indexTree(client, store, storePath, root, options = {}) {
  const {
    maxFileBytes = 512 * 1024,
    lines = 60,
    overlap = 10,
    batchSize = 16,
    // Bounds how much of a large tree one run converts into paid-for vectors.
    // The walk is alphabetical, so a limit takes a deterministic subset rather
    // than an arbitrary one, and a later run with a larger limit continues.
    maxFiles = 300,
    onProgress,
    signal,
  } = options

  const files = listFiles(root, maxFileBytes, maxFiles)

  /** Persist after every batch: embedded vectors are paid for, so losing them to
   *  a mid-run failure would waste real quota and all the elapsed time. */
  const persist = () => saveStore(storePath, store)

  const known = indexedHashes(store)
  const indexed = []
  const skipped = []
  let unchanged = 0
  let addedChunks = 0
  let tokens = 0
  let pending = []

  const flush = async () => {
    if (pending.length === 0) return
    // One vector per CHUNK, not per file. Embedding a file's joined text and then
    // indexing it as several chunks would pair one vector with many texts.
    const texts = pending.flatMap((p) => p.chunks.map((c) => c.text))
    const { vectors, tokens: used } = await embed(client, texts, signal)
    tokens += used
    let v = 0
    for (const p of pending) {
      for (const c of p.chunks) {
        store.chunks.push({
          file: p.file,
          start: c.start,
          end: c.end,
          text: c.text,
          hash: p.hash,
          vector: vectors[v++],
        })
        addedChunks++
      }
    }
    pending = []
    persist()
  }

  for (const abs of files) {
    let text
    try { text = readFileSync(abs, 'utf8') } catch { skipped.push({ file: abs, reason: 'unreadable' }); continue }
    // A NUL byte means binary content that happened to carry a text extension.
    if (text.includes('\u0000')) { skipped.push({ file: abs, reason: 'binary content' }); continue }
    const rel = relative(root, abs).split(sep).join('/')
    const hash = hashText(text)
    if (known.get(rel) === hash) { unchanged++; continue }

    removeFile(store, rel)
    const chunks = chunkText(text, { lines, overlap })
    // Very small leftovers are not worth a slot in the index.
    const worth = chunks.filter((c) => c.text.trim().length > 40)
    if (worth.length === 0) { skipped.push({ file: rel, reason: 'no indexable text' }); continue }
    pending.push({ file: rel, hash, chunks: worth })
    indexed.push(rel)
    if (pending.length >= batchSize) {
      await flush()
      if (onProgress) onProgress({ indexed: indexed.length, total: files.length, chunks: addedChunks, tokens })
    }
  }
  await flush()

  saveStore(storePath, store)
  return { indexed, skipped, unchanged, chunks: addedChunks, tokens, candidates: files.length }
}
