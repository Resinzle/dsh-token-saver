/**
 * Minimal OpenAI-compatible client for a local llama.cpp `llama-server`.
 *
 * Only the Chat Completions surface this plugin needs is implemented: one
 * non-streaming request with an optional token cap. The server is treated as
 * untrusted with respect to shape, so every field is read defensively and a
 * non-2xx response raises the server's own error text rather than a synthetic
 * message, because llama-server reports actionable diagnostics there.
 *
 * The module also owns bringing the server up when it is absent, because a
 * logon-time autostart proved unreliable on this machine (see `ensureServer`).
 *
 * @module local-offload/http
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Raised when the local server is unreachable, slow, or answers with an error. */
export class LocalModelError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'LocalModelError'
    this.code = code
  }
}

/**
 * Strip reasoning blocks. Qwen3-family models emit a `think` section before the
 * answer even when the server is asked not to expose it, and that text is
 * worthless to the caller while still costing context.
 */
export function stripReasoning(text) {
  return text
    .replace(/^\s*<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/i, '')
    .replace(/^\s*<think(?:ing)?>[\s\S]*$/i, '')
    .trim()
}

/**
 * Join a configured origin with an API path, tolerating both spelling
 * conventions for the base URL.
 *
 * The two components in this deployment disagree about what `baseUrl` means:
 * DSH's `llm-pi-ai` route wants the full API root INCLUDING `/v1`
 * (`https://api.siliconflow.cn/v1`), while a `llama-server` needs no version
 * segment at all (`http://127.0.0.1:18080`). Passing the route's value straight
 * through produced `/v1/v1/chat/completions` and a 404, so the join normalizes
 * whichever form it is given.
 */
function apiUrl(baseUrl, path) {
  const trimmed = String(baseUrl).replace(/\/+$/, '')
  const rooted = /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`
  return `${rooted}${path}`
}

/**
 * Read the bearer token for a client.
 *
 * `apiKey` may be a string or a function. A function is how a key saved into the
 * harness's credential file AFTER DSH started is picked up without a restart:
 * the value is looked up per request instead of once at composition time. A
 * string is accepted for the local route, where the value is a constant the
 * server ignores.
 *
 * @param {{apiKey?: string|(() => string)}} client
 * @returns {string}
 */
function resolveApiKey(client) {
  const key = client.apiKey
  if (typeof key === 'function') {
    try { return String(key() ?? '') } catch { return '' }
  }
  return typeof key === 'string' ? key : ''
}

/** Bearer header, omitted entirely when there is no key to send. */
function authHeaders(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
}

/**
 * Run one chat completion against the local server.
 *
 * A caller cancellation and the configured deadline race the request; whichever
 * fires first aborts it, so a stuck server cannot pin the harness turn.
 *
 * @param {{baseUrl: string, model: string, apiKey: string|(() => string), timeoutMs: number}} client
 * @param {{system: string, user: string, maxTokens: number, temperature: number}} request
 * @param {AbortSignal} [signal]
 * @returns {Promise<{text: string, promptTokens: number, completionTokens: number, finishReason: string}>}
 */
export async function complete(client, request, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('local model timeout')), client.timeoutMs)
  const onAbort = () => controller.abort(signal && signal.reason)
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    const response = await fetch(apiUrl(client.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(resolveApiKey(client)),
      },
      body: JSON.stringify({
        model: client.model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        stream: false,
        // Suppress the reasoning block. This matters a lot on a thinking model:
        // measured on Qwen/Qwen3-8B via SiliconFlow, the same one-word request
        // returned 1 output token with thinking off and 96 with it on -- the
        // reasoning consumed the entire budget and the answer came back empty.
        //
        // The two hosts spell the switch differently, so both are sent:
        //   - OpenAI-compatible hosts (SiliconFlow) read the TOP-LEVEL field
        //   - llama.cpp reads `chat_template_kwargs`
        // Measured: only the top-level form has any effect on SiliconFlow.
        // A host that rejects unknown fields would 400; if that happens for a
        // model added later, set `extraBody` in the plugin config to override.
        enable_thinking: false,
        chat_template_kwargs: { enable_thinking: false },
        ...(client.extraBody ?? {}),
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      // A 429 on a free tier means the per-minute allowance is spent, which the
      // caller must be able to tell apart from a bad key or a dead host.
      const hint = response.status === 429
        ? ' (rate limit reached -- the free allowance is per account; fall back to the local server by pointing this row back at http://127.0.0.1:18080)'
        : response.status === 401 || response.status === 403
          ? ' (credential rejected -- check SILICONFLOW_API_KEY)'
          : ''
      throw new LocalModelError(
        `delegation endpoint ${client.baseUrl} answered HTTP ${response.status}${hint}: ${body.slice(0, 400) || '(no body)'}`,
        response.status === 429 ? 'RATE_LIMITED' : 'LOCAL_HTTP_ERROR',
      )
    }

    const payload = await response.json()
    const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : undefined
    const raw = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : ''
    const text = stripReasoning(raw)
    const finishReason = String((choice && choice.finish_reason) || 'unknown')
    if (text.length === 0) {
      // Surface the finish reason: a cap-truncated or reasoning-only answer is
      // an operational problem the caller should see, not an empty success.
      throw new LocalModelError(
        `local model returned no usable text (finish_reason=${finishReason}); the model may have spent its whole budget on reasoning tokens — raise maxTokens or lower the payload size`,
        'LOCAL_EMPTY_RESULT',
      )
    }

    const usage = payload.usage || {}
    return {
      text,
      promptTokens: Number(usage.prompt_tokens || 0) || 0,
      completionTokens: Number(usage.completion_tokens || 0) || 0,
      finishReason,
    }
  } catch (error) {
    if (error instanceof LocalModelError) throw error
    if (controller.signal.aborted) {
      throw new LocalModelError(
        `local model call aborted (${client.baseUrl}); if this was a timeout, raise timeoutMs or lower the payload size`,
        'LOCAL_ABORTED',
      )
    }
    throw new LocalModelError(
      `cannot reach the local model at ${client.baseUrl}: ${error.message}. Is llama-server running?`,
      'LOCAL_UNREACHABLE',
    )
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/** Read the server's health flag without generating anything. */
export async function health(client, signal) {
  try {
    const response = await fetch(`${client.baseUrl}/health`, { signal })
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` }
    const payload = await response.json()
    return { ok: payload.status === 'ok', detail: String(payload.status || 'unknown') }
  } catch (error) {
    return { ok: false, detail: error.message }
  }
}

/**
 * Read the slot's real context window from the server.
 *
 * This matters because the payload ceiling cannot be a character count chosen
 * by guesswork. Chinese costs roughly one token per character while English
 * costs about one per four, so a ceiling that looks safe for one language
 * overruns the window in the other. A 30,000-character Chinese payload killed a
 * running server here; the failure surfaced only as "fetch failed".
 *
 * @returns {Promise<number|undefined>} n_ctx, or undefined when unavailable.
 */
export async function contextWindow(client, signal) {
  try {
    const response = await fetch(`${client.baseUrl}/props`, { signal })
    if (!response.ok) return undefined
    const payload = await response.json()
    const n = payload?.default_generation_settings?.n_ctx
    return Number.isFinite(n) && n > 0 ? n : undefined
  } catch {
    return undefined
  }
}

/** Filesystem locations of the local server's binary, model folder, and launcher. */
const LLAMA_SERVER = 'F:\\bonsai\\bin\\llama-official-vulkan\\llama-server.exe'
/**
 * Folder the router server scans. Every .gguf in it becomes one selectable
 * model id (the filename without its extension), which is what keeps the DSH
 * model list and the served list in agreement.
 */
const MODELS_DIR = 'F:\\bonsai\\models'
/** Per-model overrides, and the compatibility alias the configured model id uses. */
const MODELS_PRESET = 'F:\\bonsai\\models-preset.ini'
const LAUNCHER = 'F:\\bonsai\\start-local-ai.ps1'

/**
 * True when the configured endpoint is this machine's own llama.cpp server.
 *
 * The plugin can also point at any OpenAI-compatible endpoint (a free hosted
 * tier, for instance). That case must never try to start a local process, never
 * wait on a local health marker, and must report a network/credential problem as
 * such instead of "is llama-server running?".
 */
export function isLocalEndpoint(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}

/**
 * Cross-process "a start is already in flight" marker, shared with the DSH
 * launcher's own start step.
 *
 * Without it the launcher and this plugin race at DSH startup: the launcher
 * spawns a server, this code's first health probe still fails because the port
 * is not listening yet, and a second llama-server is spawned. The second binds
 * nothing, stays alive, and burns a whole extra copy of the model in VRAM --
 * measured as 2 x 3.6 GB of the card's 8 GB. Observed live: both processes
 * started in the same second.
 *
 * A marker older than two minutes belongs to a crashed starter and is ignored,
 * so the protocol cannot deadlock.
 */
const START_MARKER = join(tmpdir(), 'dsh-local-ai.starting')
const MARKER_STALE_MS = 120_000

function writeMarker() {
  try {
    writeFileSync(START_MARKER, String(process.pid), 'utf8')
    return true
  } catch {
    return false
  }
}

function clearMarker() {
  try { unlinkSync(START_MARKER) } catch { /* already gone */ }
}

/** True when some process is already bringing the server up right now. */
function startInFlight() {
  try {
    return Date.now() - statSync(START_MARKER).mtimeMs < MARKER_STALE_MS
  } catch {
    return false
  }
}

/**
 * Start the local server if it is not already answering, then wait for health.
 *
 * This exists because a logon-time autostart cannot be relied on: the machine
 * here had not rebooted since long before the shortcut was installed, so the
 * service was simply absent when a delegation needed it. Recovery therefore
 * lives in the call path rather than in a startup hook.
 *
 * `llama-server.exe` is spawned **directly from Node**, not through the
 * PowerShell launcher. That is deliberate and was measured: Node's `detached`
 * only puts the *immediate child* in a new process group, so when the launcher
 * was the child, the llama-server it started in turn was still inside the tree
 * and got reaped the moment the launcher exited. Spawning the server itself
 * with `detached: true` + `unref()` makes it the direct child, which survives.
 * The launcher remains the fallback for a moved binary.
 *
 * Concurrent callers -- in this process and across processes -- are collapsed
 * by the shared marker, so a burst of delegations cannot start several servers.
 *
 * @param {{baseUrl: string}} client
 * @param {number} [waitMs] - how long to wait for health before giving up.
 * @returns {Promise<{started: boolean, ok: boolean, detail: string}>}
 */
let startingPromise
export async function ensureServer(client, waitMs = 180_000) {
  let port = 18080
  try { port = Number(new URL(client.baseUrl).port) || port } catch { /* keep default */ }

  const deadline = Date.now() + waitMs
  const waitForHealth = async () => {
    let last = 'no response'
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      const probe = await health(client, AbortSignal.timeout(4_000))
      if (probe.ok) return { ok: true, detail: 'healthy' }
      last = probe.detail
    }
    return { ok: false, detail: last }
  }

  const current = await health(client, AbortSignal.timeout(5_000))
  if (current.ok) return { started: false, ok: true, detail: 'already healthy' }

  // A remote endpoint has no local process to start or wait for. Reporting that
  // plainly is more useful than spawning nothing and timing out.
  if (!isLocalEndpoint(client.baseUrl)) {
    // `/health` is a llama.cpp endpoint; an OpenAI-compatible host answers 404
    // there, which is not evidence that the host is down. Probe a real surface.
    try {
      const probe = await fetch(apiUrl(client.baseUrl, '/models'), {
        headers: authHeaders(resolveApiKey(client)),
        signal: AbortSignal.timeout(10_000),
      })
      if (probe.ok) return { started: false, ok: true, detail: 'remote endpoint answers /models' }
      return {
        started: false,
        ok: false,
        detail: `remote endpoint ${client.baseUrl} answered HTTP ${probe.status} on /models (check the API key)`,
      }
    } catch (error) {
      return {
        started: false,
        ok: false,
        detail: `remote endpoint ${client.baseUrl} is unreachable: ${error.message}`,
      }
    }
  }

  // Another process is starting it (typically the DSH launcher, which runs a
  // second before this plugin's first check). Defer instead of adding a second
  // copy of the model to VRAM.
  if (startInFlight()) {
    const waited = await waitForHealth()
    return waited.ok
      ? { started: false, ok: true, detail: 'another process was already starting it' }
      : { started: false, ok: false, detail: `another process was starting it, but it never became healthy (${waited.detail})` }
  }

  if (startingPromise === undefined) {
    startingPromise = (async () => {
      if (existsSync(LLAMA_SERVER) && existsSync(MODELS_DIR)) {
        // Router mode, matching F:\\bonsai\\start-local-ai.ps1. A single-model
        // server resurrected here would answer every model id with the one model
        // it holds, so the DSH model picker would silently stop switching.
        const args = [
          '--models-dir', MODELS_DIR,
          ...(existsSync(MODELS_PRESET) ? ['--models-preset', MODELS_PRESET] : []),
          '--models-max', '1',
          '-ngl', '99',
          '-c', '32768',
          '--host', '127.0.0.1',
          '--port', String(port),
          '-fa', 'on',
          '-ctk', 'q8_0',
          '-ctv', 'q8_0',
          '-np', '1',
          '--jinja',
          '--reasoning-format', 'none',
        ]
        // Claim before spawning, so a launcher arriving now sees the marker.
        writeMarker()
        const child = spawn(LLAMA_SERVER, args, { detached: true, stdio: 'ignore', windowsHide: true })
        child.unref()
        return { spawned: true, how: `spawned llama-server directly (pid ${child.pid})` }
      }

      if (!existsSync(LAUNCHER)) {
        return { spawned: false, how: `no server binary at ${LLAMA_SERVER} and no launcher at ${LAUNCHER}` }
      }
      writeMarker()
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', LAUNCHER],
        { detached: true, stdio: 'ignore', windowsHide: true },
      )
      child.unref()
      return { spawned: true, how: 'spawned the PowerShell launcher' }
    })().catch((error) => ({ spawned: false, how: `start attempt failed: ${error.message}` }))
      .finally(() => { startingPromise = undefined })
  }

  const attempt = await startingPromise
  const waited = await waitForHealth()
  clearMarker()
  if (waited.ok) return { started: true, ok: true, detail: `started by this call: ${attempt.how}` }
  return { started: attempt.spawned, ok: false, detail: `${attempt.how}, but the server never became healthy (${waited.detail})` }
}
