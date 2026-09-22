/**
 * `local-offload` — route token-heavy bulk-text work to a free model.
 *
 * The deployment problem this solves: a paid agent loop resends its entire
 * transcript on every step, so every large blob admitted to history is billed
 * again on each subsequent step. This plugin lets the paid model hand the blob
 * to a free endpoint and record only the compact answer, so the bulk never
 * becomes history.
 *
 * The endpoint is any OpenAI-compatible Chat Completions server. Two shapes are
 * supported and behave differently on purpose:
 *
 *  - **local** (`127.0.0.1`) — llama.cpp. Nothing to pay, nothing to rate-limit,
 *    but prefill on this machine is slow and grows worse than linearly.
 *  - **hosted free tier** — a remote free model. Faster and stronger, but bound
 *    by a metered allowance (tokens per minute), so the payload ceiling and the
 *    call rate both matter.
 *
 * The plugin is deliberately free of harness-internal imports beyond the tool
 * registry, so a harness upgrade that reshapes private seams cannot break it.
 *
 * @module dsh-plugin-local-offload
 */
import Schema from '@deepseek-ai/schemastery'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerLocalTools } from './tools.js'
import { EndpointChain } from './rotation.js'

export const name = 'local-offload'
export const inject = ['tools']

/** The harness home, matching the rest of the deployment's own resolution. */
function dshHome() {
  return process.env.DSH_HOME || join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
}

/**
 * Where the harness keeps saved credentials.
 *
 * Returned as a default so the config row can print it and a user can see which
 * file is consulted. Override with `credentialsFile` in `cordis.patch.yml`, or
 * set it to an empty string to disable the file lookup entirely.
 */
export function credentialsFileDefault() {
  return join(dshHome(), '.credentials.yaml')
}

/**
 * Read one named credential out of the harness's credential file.
 *
 * The file is the harness's own store, written by the DSH Models page and by
 * `ctx.credentials.set`. Its format is `version: 1` followed by top-level
 * mappings; the saved keys live under `refs:`. This reads only the single
 * requested name and only the scalar on its line, so nothing else in the file is
 * parsed, returned, or logged.
 *
 * Deliberately tolerant: a missing file, an unreadable file, or a name that is
 * not present all return `undefined` so the caller can fall back and report the
 * result, rather than throwing at a point where the operator cannot act.
 *
 * @param {string} path - absolute path to the credential file.
 * @param {string} ref - the credential name, e.g. `SILICONFLOW_API_KEY`.
 * @returns {string|undefined}
 */
export function readCredentialFile(path, ref) {
  if (!path || !ref) return undefined
  try {
    const text = readFileSync(path, 'utf8')
    // A top-level `refs:` block; the name is a key inside it at any indentation.
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

/**
 * Resolve one credential, reporting which source supplied it.
 *
 * Order is deliberate and mirrors the harness's own precedence, with the file
 * added as the last resort because the harness never materializes it into the
 * environment (see `credentialsFile` in the schema for the measurement):
 *
 *   1. the literal `apiKey` from config, when `apiKeyEnv` is not set at all
 *   2. the environment variable named by `apiKeyEnv`      (launch environment wins)
 *   3. the credential file, under that same name
 *   4. the literal `apiKey` as a declared fallback       (a placeholder, usually)
 *
 * @returns {{value: string, source: 'literal'|'environment'|'credentials-file'|'literal-fallback'}}
 */
export function resolveCredential(config, ref, filePath) {
  if (!ref) return { value: config.apiKey, source: 'literal' }
  const fromEnv = process.env[ref]
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return { value: fromEnv, source: 'environment' }
  const fromFile = readCredentialFile(filePath, ref)
  if (fromFile !== undefined) return { value: fromFile, source: 'credentials-file' }
  return { value: config.apiKey, source: 'literal-fallback' }
}

/** Plugin configuration; the defaults target a local llama.cpp server. */
export const Config = Schema.object({
  /** Origin of the OpenAI-compatible endpoint, without a trailing `/v1`. */
  baseUrl: Schema.string().default('http://127.0.0.1:18080'),
  /** Model id sent to the endpoint. */
  model: Schema.string().default('local-qwen3-8b'),
  /**
   * Literal bearer token. Local servers ignore it; a hosted endpoint needs a
   * real key. Prefer `apiKeyEnv` so no secret is stored in configuration.
   */
  apiKey: Schema.string().default('local-no-key'),
  /**
   * Name of an environment variable holding the key. When set and non-empty it
   * wins over `apiKey`.
   */
  apiKeyEnv: Schema.string().default(''),
  /** Cooperative per-call deadline in milliseconds. */
  timeoutMs: Schema.number().default(300_000),
  /** Character ceiling on one payload before it is truncated with a warning. */
  maxInputChars: Schema.number().default(400_000),
  /** Default output token ceiling for one call. */
  maxOutputTokens: Schema.number().default(1024),
  /** Sampling temperature; low keeps extraction faithful. */
  temperature: Schema.number().default(0.2),
  /**
   * Context window to assume when the endpoint cannot report one. A remote
   * OpenAI-compatible host has no llama.cpp `/props`, so this is the authority
   * there. `0` leaves the window unknown and falls back to a conservative
   * default.
   */
  maxContextTokens: Schema.number().default(0),
  /**
   * Extra JSON fields merged into every request body, as a JSON object string.
   *
   * An escape hatch: the built-in body already suppresses reasoning with both
   * the top-level `enable_thinking` and `chat_template_kwargs` spellings, and a
   * future model added here might want a different one, or might reject an
   * unknown field outright. Empty means "send nothing extra".
   */
  extraBody: Schema.string().default(''),
  /**
   * Ordered rotation chain, as a JSON array of `"baseUrl|model"` strings.
   *
   * Entries are tried in order when the primary returns HTTP 429 or is
   * unreachable. The endpoints are free and their per-minute allowances are
   * measured to be per MODEL, not per account, so rotating side-steps a throttle
   * instead of waiting it out. Put the local llama.cpp server last: it has no
   * quota at all, which is exactly what makes it the floor of the chain.
   *
   * Example:
   *   ["https://api.siliconflow.cn/v1|THUDM/GLM-4-9B-0414",
   *    "https://api.siliconflow.cn/v1|Qwen/Qwen3-8B",
   *    "http://127.0.0.1:18080|local-qwen3-8b"]
   */
  chain: Schema.string().default(''),
  /**
   * Credential reference for the chain entries. Defaults to `apiKeyEnv`, which
   * is correct when the whole chain lives on one host. Set it separately when
   * the chain spans hosts with different keys.
   */
  chainApiKeyEnv: Schema.string().default(''),
  /**
   * Read a credential out of the harness's own credential file when the
   * environment variable named by `apiKeyEnv` is not set.
   *
   * This is not a convenience. It is the difference between working and a 401.
   * `dsh-credentials-local` stores keys in `<DSH_HOME>/.credentials.yaml` under
   * a `refs:` mapping and resolves them ON DEMAND for the harness's own routes;
   * it deliberately does not materialize them into `process.env`. Verified
   * against the installed harness: the only two places that write `process.env`
   * are `dsh-app-boot` (which materializes `.env` FILES, a different store) and
   * `dsh-http-proxy`. So a plugin that reads `process.env[apiKeyEnv]` at
   * composition time gets `undefined` for every user who saved their key through
   * the DSH Models page or wrote it into `.credentials.yaml` -- which is the
   * documented way to save one -- and then sends a placeholder.
   *
   * The file is read lazily, on the first call that needs it, for two reasons:
   * a key saved after DSH starts is picked up without a restart, and a missing
   * file costs nothing at load time. Its on-disk format is the harness's own and
   * is stable (`version: 1` plus a flat `refs:` map), and only the single
   * requested key is ever read.
   *
   * Set to an empty string to disable the lookup and require a real environment
   * variable, which is the right choice in a container where the key is injected.
   */
  credentialsFile: Schema.string().default(credentialsFileDefault()),
  /** Seconds a rate-limited endpoint is parked before it is tried again. */
  cooldownSeconds: Schema.number().default(65),
})

export function apply(ctx, config) {
  const log = (level, message, ...args) => {
    if (ctx.logger && typeof ctx.logger[level] === 'function') ctx.logger[level](message, ...args)
  }

  // Resolve the credential through the environment first, then the harness's own
  // credential file. Reading the file is what makes a hosted endpoint work at
  // all: the harness resolves `apiKeyEnv` references for its own routes but never
  // exports them, so a plugin that reads only `process.env` sends a placeholder
  // to every user who saved their key through the DSH Models page.
  //
  // Resolution is repeated per request rather than captured here, so a key saved
  // after DSH started is used without a restart. The one load-time resolution
  // below exists only to report the resolved source, and to say so loudly when
  // there is none -- that state produces a 401 on the first call and nothing
  // else would explain it.
  const credentialFile = config.credentialsFile || undefined
  const primary = resolveCredential(config, config.apiKeyEnv, credentialFile)

  if (primary.source === 'credentials-file') {
    log('info', 'local-offload: %s resolved from %s', config.apiKeyEnv, credentialFile)
  } else if (primary.source === 'literal-fallback') {
    log('warn',
      'local-offload: %s is set but resolved nowhere — not in the launch environment, and not in %s. Falling back to the configured apiKey, which a hosted endpoint will reject. Save the key in the DSH Models page, or export %s.',
      config.apiKeyEnv, credentialFile || '(credential file lookup disabled)', config.apiKeyEnv)
  } else if (primary.source === 'literal' && config.apiKeyEnv) {
    log('warn', 'local-offload: apiKeyEnv is empty, using the literal apiKey from configuration')
  }

  const client = {
    baseUrl: config.baseUrl.replace(/\/+$/, ''),
    model: config.model,
    // A function, so the lookup happens per request (see `resolveApiKey`).
    apiKey: () => resolveCredential(config, config.apiKeyEnv, credentialFile).value,
    timeoutMs: config.timeoutMs,
  }

  // Parse the optional passthrough body once, so a typo fails at load with a
  // clear message instead of throwing on every delegation.
  if (config.extraBody && config.extraBody.trim().length > 0) {
    try {
      const parsed = JSON.parse(config.extraBody)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('must be a JSON object')
      }
      client.extraBody = parsed
    } catch (error) {
      throw new Error(`local-offload: extraBody is not a valid JSON object (${error.message})`)
    }
  }

  // Rotation chain: a JSON array of "baseUrl|model".
  //
  // Each entry resolves its own credential rather than inheriting whatever the
  // primary ended up with. That matters: an invalid primary key would otherwise
  // be copied onto every chain entry, so the whole chain would fail 401 together
  // and the rotation could not rescue anything -- which is exactly the case a
  // fallback exists for. (Found by the integration test, not by inspection.)
  const chainApiKeyEnv = config.chainApiKeyEnv || config.apiKeyEnv
  // Same resolution order as the primary, but under the chain's own name, so a
  // wrong primary key cannot take the whole chain down with it. Only the source
  // is needed here, to report it; each entry resolves its own value per request.
  const chainCredential = resolveCredential(config, chainApiKeyEnv, credentialFile)
  if (chainCredential.source === 'literal-fallback' && chainApiKeyEnv) {
    log('warn',
      'local-offload: chain credential %s resolved nowhere either; chain entries send the configured apiKey',
      chainApiKeyEnv)
  }

  let chainEntries = []
  if (config.chain && config.chain.trim().length > 0) {
    let parsed
    try {
      parsed = JSON.parse(config.chain)
    } catch (error) {
      throw new Error(`local-offload: chain is not valid JSON (${error.message})`)
    }
    if (!Array.isArray(parsed)) throw new Error('local-offload: chain must be a JSON array of "baseUrl|model" strings')
    chainEntries = parsed.map((entry, i) => {
      if (typeof entry !== 'string' || !entry.includes('|')) {
        throw new Error(`local-offload: chain[${i}] must look like "baseUrl|model"`)
      }
      const [url, model] = entry.split('|').map((s) => s.trim())
      if (!url || !model) throw new Error(`local-offload: chain[${i}] needs both a base URL and a model`)
      return {
        baseUrl: url.replace(/\/+$/, ''),
        model,
        // Lazy for the same reason as the primary: a credential saved after DSH
        // started must be picked up without a restart.
        apiKey: () => resolveCredential(config, chainApiKeyEnv, credentialFile).value,
        timeoutMs: config.timeoutMs,
      }
    })
  }

  const chain = new EndpointChain(chainEntries, {
    cooldownMs: Math.max(1, config.cooldownSeconds) * 1000,
    onEvent: (e) => {
      if (ctx.logger && typeof ctx.logger.info === 'function') {
        ctx.logger.info('local-offload: rotation %s %s%s', e.type, e.endpoint, e.reason ? ` (${e.reason})` : '')
      }
    },
  })

  registerLocalTools(
    ctx,
    client,
    config.maxInputChars,
    config.maxOutputTokens,
    config.temperature,
    config.maxContextTokens,
    chain,
  )
  if (ctx.logger && typeof ctx.logger.info === 'function') {
    ctx.logger.info(
      'local-offload: local_delegate registered against %s (model %s, ceiling %s, %d rotation endpoint(s))',
      client.baseUrl,
      client.model,
      config.maxContextTokens > 0 ? String(config.maxContextTokens) : 'probed-or-default',
      chain.entries.length,
    )
  }
}
