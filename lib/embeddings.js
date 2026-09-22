/**
 * Embedding and reranking against an OpenAI-compatible endpoint.
 *
 * This is the piece that makes free hosted models save CONTEXT rather than just
 * money: instead of reading a whole document into the paid conversation, the
 * document is embedded once into a local vector store and only the few most
 * relevant chunks are ever read back. Measured on SiliconFlow, `BAAI/bge-m3`
 * costs nothing and carries 500,000 tokens/minute -- ten times a chat model's
 * allowance -- which is what makes bulk indexing practical.
 *
 * @module local-offload/embeddings
 */

/**
 * Join a configured origin with an API path, tolerating both spelling
 * conventions for the base URL.
 *
 * Two components in this deployment disagree about what `baseUrl` means: DSH's
 * `llm-pi-ai` route wants the full API root INCLUDING `/v1`, while a local
 * `llama-server` has no version segment at all. Passing the route value through
 * unchanged produced `/v1/v1/...` and a 404, so both forms are normalized here.
 */
export function apiUrl(baseUrl, path) {
  const trimmed = String(baseUrl).replace(/\/+$/, '')
  const rooted = /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`
  return `${rooted}${path}`
}

/** Bearer header, omitted entirely when there is no key to send. */
export function authHeaders(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
}

/** One embedding request failed in a way the caller should see. */
export class EmbeddingError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'EmbeddingError'
    this.code = code
  }
}

/**
 * Embed a batch of texts.
 *
 * Batching matters: the free allowance is metered per minute, so one request
 * carrying 32 texts spends the same tokens as 32 requests but one unit of the
 * request-rate budget, and it finishes sooner.
 *
 * @param {{baseUrl: string, apiKey: string, embeddingModel: string, timeoutMs: number}} client
 * @param {string[]} texts
 * @param {AbortSignal} [signal]
 * @returns {Promise<{vectors: number[][], tokens: number}>}
 */
export async function embed(client, texts, signal) {
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new EmbeddingError('embed() needs at least one text', 'EMPTY_INPUT')
  }

  // A transient network failure or a burst of 429s must not abort an index run:
  // batches already embedded are durable, so retrying is always cheaper than
  // restarting. Backoff is multiplicative with jitter so parallel callers do not
  // resynchronise onto the same retry instant.
  let lastError
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(30_000, 1500 * 2 ** (attempt - 1)) * (0.5 + Math.random())
      await new Promise((r) => setTimeout(r, backoff))
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('embedding timeout')), client.timeoutMs ?? 120_000)
    const onAbort = () => controller.abort(signal?.reason)
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      const response = await fetch(apiUrl(client.baseUrl, '/embeddings'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(client.apiKey) },
        body: JSON.stringify({ model: client.embeddingModel, input: texts }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        // 429 and 5xx are worth another try; a 4xx is a request problem that
        // will fail identically every time.
        if (response.status === 429 || response.status >= 500) {
          lastError = new EmbeddingError(
            `HTTP ${response.status} ${body.slice(0, 200)}`,
            response.status === 429 ? 'RATE_LIMITED' : 'SERVER_ERROR',
          )
          continue
        }
        throw new EmbeddingError(
          `embeddings endpoint answered HTTP ${response.status}: ${body.slice(0, 300) || '(no body)'}`,
          'HTTP_ERROR',
        )
      }
      const payload = await response.json()
      const data = Array.isArray(payload?.data) ? payload.data : []
      // Sort by index: the API does not promise response order matches request
      // order, and silently pairing the wrong vector with the wrong text would
      // produce plausible-looking but wrong search results.
      const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      const vectors = ordered.map((d) => d.embedding)
      if (vectors.length !== texts.length) {
        throw new EmbeddingError(`expected ${texts.length} vectors, got ${vectors.length}`, 'SHAPE_MISMATCH')
      }
      return { vectors, tokens: Number(payload?.usage?.total_tokens ?? 0) || 0 }
    } catch (error) {
      lastError = error instanceof EmbeddingError ? error : new EmbeddingError(String(error?.message ?? error), 'UNREACHABLE')
      // An abort from the caller is final; a timeout or reset is worth retrying.
      if (signal?.aborted) throw new EmbeddingError('embedding call aborted by caller', 'ABORTED')
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }
  throw lastError ?? new EmbeddingError('embedding failed with no recorded reason', 'UNKNOWN')
}

/**
 * Rerank candidate documents against a query.
 *
 * The reranker is what turns "roughly relevant" into "actually answers this".
 * It is a cross-encoder: it scores query and document together, which is far
 * more accurate than comparing two independent embeddings, and it is free here.
 *
 * @returns {Promise<{index: number, score: number}[]>} best-first, original indices
 */
export async function rerank(client, query, documents, topN, signal) {
  if (!client.rerankModel) return documents.map((_, index) => ({ index, score: 0 })).slice(0, topN)
  try {
    const response = await fetch(apiUrl(client.baseUrl, '/rerank'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(client.apiKey) },
      body: JSON.stringify({
        model: client.rerankModel,
        query,
        documents,
        top_n: Math.min(topN, documents.length),
      }),
      signal: signal ?? AbortSignal.timeout(client.timeoutMs ?? 120_000),
    })
    if (!response.ok) return undefined
    const payload = await response.json()
    const results = Array.isArray(payload?.results) ? payload.results : []
    return results.map((r) => ({ index: Number(r.index), score: Number(r.relevance_score ?? 0) }))
  } catch {
    // Reranking is an optimisation, not a requirement: the caller falls back to
    // cosine order rather than failing the search.
    return undefined
  }
}

/** Cosine similarity of two equal-length vectors. */
export function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
