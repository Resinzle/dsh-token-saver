# Configuration templates

DSH composes configuration in layers, and a patch **replaces the targeted row's entire `config`** rather than merging into it. That single fact causes most of the confusing failures in this area: a patch that sets one key silently deletes every other key that row needs, and a patch that targets a row a later layer also targets loses without any error.

Two consequences for anything you copy from here:

1. **Every template restates the complete config for each row it touches**, including keys it is not changing. Do not trim them.
2. **Layer order decides the winner**, later layers first:

   1. each bundle in `dsh.profile.bundles`, in list order
   2. the profile's own `cordis.patch.yml`
   3. `$DSH_HOME/cordis.patch.yml`
   4. each `--patch <path>` overlay, in argv order

## Which template to use

| Template | Endpoint | Needs | Use when |
|---|---|---|---|
| [`profile-patch.hosted.yml`](profile-patch.hosted.yml) | a hosted free tier, local server as floor | an API key | you have a free-tier key and want the cheapest option that still works when the quota runs out |
| [`profile-patch.local-only.yml`](profile-patch.local-only.yml) | a local `llama.cpp` server only | a GPU and a model file | you want no external service, no key, and no quota |

Both include the two configuration changes that are worth more than the plugin itself: the spill cap and the session-title route. Neither is optional if the goal is to reduce the bill — see [`docs/measurements.md`](../docs/measurements.md) for the numbers behind that claim.

## Where the file goes

The templates target a profile named `web`, the name DSH's Web app uses. Adjust if yours differs.

```
$DSH_HOME/profiles/web/cordis.patch.yml          # the profile's own patch layer
```

A profile's own patch is the right home for these values: it applies to every session on that profile and does not need `--patch` on every launch.

## Installing the templates

Do not hand-edit JSON while installing. `dsh plugin` forwards to pnpm, which writes the profile manifest itself, and that avoids the encoding failure described in [`docs/troubleshooting.md`](../docs/troubleshooting.md#dsh-will-not-start-at-all-after-editing-a-profile-file).

```sh
# 1. install the plugin (adds the dependency and the bundle entry)
dsh plugin --profile web add ./dsh-token-saver

# 2. copy the template you want over the profile patch
#    (back up the existing one first)

# 3. confirm the composition, then restart DSH
dsh --profile web --dump-config
```

`--dump-config` prints the composed layers. Look for your values in the `dsh-plugin-local-offload` and `spill-policy` rows; if a value is missing, a later layer replaced that row's whole config.

## The values, and why each one

| Row | Key | Shipped default | Template value | Why |
|---|---|---|---|---|
| `spill-policy` | `maxInlineBytes` | `50000` | `12000` | The shipped cap fired on 1 result out of 1,918 in measurement (2.0% of tool text). At 12,000 it captures 39 results carrying 33.0%. This is the largest single saving available. |
| `session-title-llm` | `provider` / `model` | the session's paid route | a free route | A title is a mechanical 5-word summary. Moving it removes one paid request per session. Small, but free. |
| `session-query-sqlite` | `path` / `openAt` | `:memory:` / `never` | a durable path / `first-search` | Shipped, the index is rebuilt from nothing every start and search is disabled. `first-search` defers importing `node:sqlite` until a search actually runs, so DSH's boot path gains no failure surface. The path must be a derived store, never the session-persistence store. |
| `local-offload` | `chain` | — | ordered endpoints | Rotating side-steps a per-minute throttle instead of waiting it out. Put the endpoint with no quota last. |
| `local-offload` | `maxContextTokens` | `0` | the endpoint's real window | A remote host does not answer `llama.cpp`'s `/props`, so this value is the authority for payload sizing there. A wrong ceiling is a rejected request, not a slow one. |
| `local-offload` | `credentialsFile` | `<DSH_HOME>/.credentials.yaml` | same | Where to read a saved credential when the environment variable is not set. See below — this one is not optional in practice. |

## Where the credential actually comes from

The harness stores saved keys in `<DSH_HOME>/.credentials.yaml`, and the DSH Models page writes them there. Its `dsh-credentials-local` provider resolves a name such as `SILICONFLOW_API_KEY` **on demand for the harness's own routes** — that is what makes the `siliconflow` provider in `settings.yaml` work, and it is why the session-title route needs no extra configuration.

It does **not** export those values into the process environment. Verified against the installed harness: the only two places that write `process.env` are `dsh-app-boot`, which materializes `.env` **files** (a different store), and `dsh-http-proxy`. So a plugin that does `process.env[apiKeyEnv]` gets `undefined` no matter how correctly the key was saved — and this project's first release did exactly that, sent the placeholder `local-no-key` as a bearer token, and received HTTP 401 on every delegation.

The plugin therefore resolves the credential itself, per request, in this order:

1. the environment variable named by `apiKeyEnv` — the launch environment still wins, so a container that injects the key needs no change
2. the file named by `credentialsFile`, under that same name
3. the literal `apiKey` from configuration — a declared fallback, and it logs a warning when it is used, because a hosted endpoint will reject it

Resolution repeats per request rather than at load, so a key saved after DSH started is used without restarting the server. `test/test-credentials.mjs` covers the order and every edge case.

If you inject the key as a real environment variable and want to forbid the file lookup — the right choice in a container — set `credentialsFile: ''`.

## Two mistakes worth avoiding

**Setting `maxInlineBytes` below about 8,000.** `@deepseek-ai/dsh-compaction-tool-result-pruner` already fires at 8,192 chars, and the spill preview is the model's only immediate view of that output. Below that line you force a retrieval round-trip on results that are often read once and never needed again. `read` results are exempt from the policy, so source files are unaffected at any value.

**Putting a reasoning model in a chain.** `THUDM/GLM-Z1-9B-0414` and `deepseek-ai/DeepSeek-R1-0528-Qwen3-8B` ignore `enable_thinking: false` and spend 68–143 output tokens saying one word, which defeats the entire purpose of routing mechanical work to a free model. Detect it by a `reasoning_content` field in the response.

**Assuming `apiKeyEnv` alone is enough.** See above. If a hosted delegation returns HTTP 401 while the same key works in the DSH Models page, this is why.
