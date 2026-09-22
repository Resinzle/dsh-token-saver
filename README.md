# 大肥鱼少吃点我的token……节省一下！（dsh-token-saver）

> ⚠️ 维护状态 / Maintenance Status
> 这是一个个人实验项目，由 AI 协助整理发布。作者是编程新手，没有时间或能力持续维护。
> 代码按“原样”提供，不保证兼容未来版本，不提供技术支持。请自行阅读代码、评估风险后使用。
>
> This is a personal experimental project, published with AI assistance. The author is a beginner and cannot provide ongoing maintenance or support. The code is provided "as is", without warranty of any kind. Use at your own risk.

> ### 🇨🇳 中文说明在这里 → **[README.zh.md](README.zh.md)**
>
> **不懂命令行、想直接装上用？** 把这份文件整个复制给 AI 助手，让它照着装：
> **[docs/install-with-ai.zh.md](docs/install-with-ai.zh.md)**
>
> 这份英文 README 是给英文读者的；中国人请从上面两个链接进。
> 其余文档（小白版/技术版介绍、架构、实测数据、兼容性、排障）索引在 [`docs/`](docs/README.md)。

**Cut the token bill of a DSH agent session by keeping bulky text out of the transcript.**

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin plus the measured configuration and the measurement tools that go with it. No build step, no harness-internal imports, two public dependencies.

**New here?** Read the [plain-language introduction](docs/intro-beginner.en.md) or the [technical one](docs/intro-professional.en.md). To hand installation to an AI assistant, give it [docs/install-with-ai.zh.md](docs/install-with-ai.zh.md) (Chinese).

---

## The problem is not the model's price

An agent loop does not make one request per conversation. It makes one request per **step**, and every request carries the whole transcript built so far. From this project's own session logs:

| Measure | Value | Command |
|---|---|---|
| Requests in one session | **672** | `test/turns-report.mjs` |
| Prompt tokens in that session | **287,481,671** | `test/cost-report.mjs` |
| Median prompt size per request | **252,044 tokens** | `test/cost-report.mjs` |
| Cache hit rate, all sessions | **99.3%** | `test/cost-report.mjs` |

Read that third row again. The median request re-sends a quarter of a million tokens, and almost all of it is history.

**The cache does not save you.** 99.3% of prompt tokens are cache hits, and the measured bill is still **50.0% cache-hit input** — because cached input is billed. A high hit rate means the prefix is stable, not that replay is free.

So the lever is not "find a cheaper model". It is **reduce what gets re-sent**:

```
cost  ≈  (average context size)  ×  (number of requests)
```

Both factors are under your control, and this project attacks both.

## What it actually does, with the measured effect

| Mechanism | Measured effect | Where it lives |
|---|---|---|
| **Spill oversized tool output** | The shipped 50 KB cap fired on **1 of 1,918** results (2.0% of tool text). At **12 KB it captures 39 results carrying 33.0%**. A verified 60,562-byte output put ~11,600 bytes into the transcript. | configuration |
| **Delegate bulk text to a free model** | A verified delegation turned a 14,366-character payload into a **122-character** answer — and the answer is what gets re-sent from then on. | this plugin |
| **Rotate when a free model throttles** | The free per-minute allowance is **per model, not per account** (verified). A throttled model is side-stepped in about a second instead of waited out for a minute. | this plugin |
| **Measure the bill from the logs** | Four scripts report where the tokens actually went, so the next decision is evidence-based. | this repo |

One more number, because it is the cheapest win of all: measured **requests per human turn ranged from 1.0 to 84.0**. One session here spent **84 requests on a single user turn**. Fewer, better-aimed tool calls cost nothing to adopt.

## Honest accounting

- **The biggest single saving is a configuration value, not this plugin.** Lowering `maxInlineBytes` from the shipped 50,000 to 12,000 is worth more than everything the plugin does. If you only do one thing, do that.
- **Routing session titles off the paid route is a small win**, configured and not oversold. The bill is replay, not titles.
- **Compaction was deliberately left on the paid route.** Its summariser replays the conversation prefix verbatim, which would be slow on a local model, and a session containing images would fail outright because the local models declare text-only input.
- **Cache hits are 50% of the bill and this project does not reduce that share.** It reduces the volume being cached. The distinction matters if you are choosing where to spend effort.
- **Numbers here come from one machine's logs.** The scripts are included so you can check yours before believing any of it. See [docs/measurements.md](docs/measurements.md).

## Quick start

Requires DSH `0.1.5-rc.2` or later (see [compatibility](#version-compatibility)) and Node 22.19+.

```sh
# 1. install the plugin into a profile (pnpm writes the profile manifest)
dsh plugin --profile web add ./dsh-token-saver

# 2. apply the configuration that does the real work
#    copy ONE template over $DSH_HOME/profiles/web/cordis.patch.yml
#      templates/profile-patch.hosted.yml      hosted free tier + local floor
#      templates/profile-patch.local-only.yml  local llama.cpp only

# 3. confirm the composition, then restart DSH
dsh --profile web --dump-config

# 4. check that everything still applies
node tools/doctor.mjs
```

Step 2 is not optional. Installing the plugin alone will not noticeably change your bill — the spill cap and the free-model routes are what move it.

The plugin loads when the **DSH server restarts**, not on a page reload: a profile's bundle list is read once at composition time.

### Editing the source afterwards: `link:` versus `file:`

`dsh plugin add <path>` installs a **`link:`** dependency, which is a directory junction (or symlink) to your checkout. Verified by installing this plugin into a throwaway profile and inspecting the result:

```
dependencies: { "dsh-plugin-local-offload": "link:C:/…/dsh-token-saver" }
node_modules/dsh-plugin-local-offload → Junction → C:\…\dsh-token-saver
```

So with the documented install command, **editing this checkout needs only a DSH restart** — no reinstall. `tools/doctor.mjs` confirms it by comparing the two paths and reports `installed copy is byte-identical to this source checkout`.

A **`file:`** dependency, by contrast, is a **copy**. That is what an older hand-rolled installer produced, and with it every source edit needs a reinstall *and* a restart. If `doctor.mjs` reports the installed copy as differing, check which spec your profile uses:

```sh
grep dsh-plugin-local-offload "$DSH_HOME/profiles/web/package.json"
```

To switch a `file:` install to `link:`:

```sh
dsh plugin --profile web remove dsh-plugin-local-offload
dsh plugin --profile web add /path/to/dsh-token-saver
```

`dsh plugin add <path>` also works with nothing but this checkout on disk — it does not need a registry, and it writes the profile manifest itself, so no BOM can be introduced by hand.

### Configuration

The tool is configured from the profile's `cordis.patch.yml`, so it can be retuned without touching the plugin. Full values and their reasoning are in [`templates/README.md`](templates/README.md).

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:18080` | Origin of the OpenAI-compatible endpoint, without a trailing `/v1` |
| `model` | `local-qwen3-8b` | Model id sent to the endpoint |
| `apiKey` / `apiKeyEnv` | `local-no-key` / unset | Literal bearer token, or the name of an environment variable holding it. Prefer `apiKeyEnv` so no secret sits in configuration |
| `chain` | `''` | Ordered rotation, as a JSON array of `"baseUrl|model"` strings |
| `chainApiKeyEnv` | follows `apiKeyEnv` | Separate credential for chain entries on other hosts |
| `cooldownSeconds` | `65` | How long a rate-limited endpoint is parked. The allowance is per minute |
| `maxContextTokens` | `0` | Context window to assume when the endpoint cannot report one |
| `maxInputChars` | `400000` | Character ceiling on one payload before truncation with a warning |
| `maxOutputTokens` | `1024` | Default output ceiling per call |
| `timeoutMs` | `300000` | Per-call deadline |
| `temperature` | `0.2` | Low, to keep extraction faithful |
| `extraBody` | `''` | JSON object merged into every request body, as an escape hatch |
| `credentialsFile` | `<DSH_HOME>/.credentials.yaml` | Where to read a saved credential when the environment variable is not set. Empty disables the lookup |

`maxInputChars` is a coarse guard; the effective ceiling is derived from the endpoint's real token window (75% of it, minus the output budget), capped at 7,000 tokens per call so that one delegation cannot spend a whole minute's quota.

### Where the API key comes from

Save it once in the DSH Models page, or add it under `refs:` in `<DSH_HOME>/.credentials.yaml`:

```yaml
refs:
  SILICONFLOW_API_KEY: sk-...
```

Then name it in the config with `apiKeyEnv: SILICONFLOW_API_KEY`.

**Do not expect `process.env` to contain it.** The harness resolves `apiKeyEnv` references on demand for its own routes; it does not export them into the process environment. Verified against the installed harness: the only two writers of `process.env` are `dsh-app-boot`, which materializes `.env` **files** (a different store), and `dsh-http-proxy`. This plugin's first release read `process.env[apiKeyEnv]`, sent the placeholder, and got **HTTP 401 on every delegation** — which is why the plugin now resolves the credential itself, per request, falling back from the environment to `credentialsFile` and only then to the literal placeholder.

If you inject the key as a real environment variable, that still wins, and setting `credentialsFile: ''` forbids the file lookup — the right choice in a container.

### The tool

`local_delegate(task, instruction, text, maxTokens?)`

| `task` | Use for |
|---|---|
| `summarize` | Dense factual digest of a long document or log |
| `extract` | Pull specific fields, identifiers, or findings out of bulk text |
| `classify` | Assign a label from the instruction |
| `translate` | Translate while preserving code and identifiers |
| `rewrite` | Restructure without losing facts |
| `answer` | Answer a question using only the payload as evidence |
| `code` | Analyse code; name files, symbols, and line-level issues |

Every result ends with a line naming the model and its token counts, so the saving is visible rather than assumed. A rotation adds a second line naming the chain state.

## Version compatibility

| Harness version | Status |
|---|---|
| `0.1.5-rc.2` | **Verified** — written and measured on it |
| `master` (current checkout) | **API verified** — plugin API and all four config row ids checked against the official repository |
| later versions | **Untested** — not known-broken, simply not verified |
| `0.1.2-alpha.*`, `0.1.3-alpha.*`, `0.1.5-alpha.*` | **Not supported** — `0.1.2-alpha` was an architecture refactor with a plugin-compatibility notice |

Run `node tools/doctor.mjs` after any upgrade. It needs no dependencies and reports which of the four config rows still exists, whether `defineTool`'s signature still matches, whether the plugin's dependency surface is still clean, and whether `~/.dsh` has BOM damage. Exit code is non-zero when something broke.

**Failure is designed to be quiet and survivable:** if a config row is renamed, that patch becomes a no-op and DSH falls back to shipped behaviour. Nothing crashes. The plugin itself fails loudly (it will not load) if its own API changes.

[docs/compatibility.md](docs/compatibility.md) explains what to check after an upgrade, how to repair each failure mode, and — deliberately — **how to rebuild all four mechanisms from scratch** if this plugin never works again. That last section is written to outlive this repository.

## What this repo does not do

- It does **not** lower the price per token, and it does not switch your model.
- It does **not** implement spill. Spill happens inside the harness; the plugin cannot influence it. This repo measures and configures it.
- It does **not** require a GPU for the hosted configuration. The local `llama.cpp` server is optional and is the floor of the chain, not a prerequisite.
- It does **not** turn a paid model into a free one. The paid model stays primary; the goal is to spend fewer of *its* tokens.

## Repository layout

| Path | Role |
|---|---|
| `lib/index.js` | Plugin entry: `Config` schema and `apply` |
| `lib/tools.js` | The `local_delegate` tool: task contracts, payload clamping, cross-chain attempts |
| `lib/rotation.js` | `EndpointChain`: per-endpoint cooldowns, automatic recovery. No harness imports |
| `lib/http.js` | OpenAI-compatible client, reasoning stripping, URL normalisation, local-server self-heal |
| `lib/embeddings.js`, `lib/indexer.js`, `lib/vector-store.js` | Semantic-retrieval prototype, measured and parked (no corpus that gets queried repeatedly) |
| `tools/doctor.mjs` | Post-upgrade self-check. Zero dependencies |
| `tools/gh-tunnel.mjs` | Local CONNECT proxy for GitHub when DNS is blocked. See [troubleshooting](docs/troubleshooting.md#working-offline-or-behind-a-blocked-dns) |
| `templates/` | Profile patch templates, with the reasoning beside each value |
| `test/` | Measurement and verification scripts |
| `.github/workflows/ci.yml` | Regression net: syntax, credential rules, rotation, encoding, self-check |
| `docs/` | [architecture](docs/architecture.md), [measurements](docs/measurements.md), [compatibility](docs/compatibility.md), [troubleshooting](docs/troubleshooting.md), [sponsorship](docs/sponsor.md) |
| `docs/publishing.zh.md` | 从零发布到 GitHub 的逐步指引（中文），含本机实测的网络结论与 token 安全边界 |

## Design constraints worth knowing

- **Two public imports only:** `@deepseek-ai/dsh-tools` (`defineTool`) and `@deepseek-ai/schemastery`. No harness-internal module. `node tools/doctor.mjs` re-checks this against the shipped source rather than taking it on trust.
- **The tool definition matches the official tutorial field for field**, so it is not relying on an undocumented seam.
- **No build step.** Pure ESM JavaScript. This matters for distribution: a TypeScript package installed from a git host arrives without its `lib/` output and fails to load, and pnpm ≥ 10 additionally refuses to run a git dependency's `prepare` script until the user allowlists it — which is permission to execute the package's code at install time. Prebuilt or tarball distribution sidesteps all of it, and this package needs neither.
- **No hardcoded tunables.** Every deployment-varying choice is a validated `Config` field changeable from `cordis.patch.yml`, which is the convention the harness's own `AGENTS.md` requires of plugins.

## Tests

**There are no third-party dependencies anywhere in this repository** — not in the plugin, and not in the tests. Every script below runs with nothing installed.

```sh
node tools/doctor.mjs                 # post-upgrade self-check; runs from anywhere
node tools/doctor.mjs --strict        # warnings are fatal too; this is what CI runs
node tools/verify-live.mjs            # end-to-end acceptance (see below)
node test/test-credentials.mjs        # credential resolution order and edge cases
node test/test-rotation.mjs           # rotation unit tests: park, skip, recover, multi-park
node test/test-yaml-min.mjs           # the YAML reader, diffed against js-yaml when available
node test/tunnel-resilience.mjs       # the GitHub tunnel survives reset storms
node test/check-bom.mjs               # BOM / JSON damage scan under $DSH_HOME
node test/cost-report.mjs             # billing attribution from your own session logs
node test/profile-report.mjs          # tool-output volume and per-request prompt sizes
node test/turns-report.mjs            # requests per human turn
node test/cache-report.mjs            # per-session cache and compaction counts
node tools/check-links.mjs            # every relative documentation link resolves
```

### Setup for the scripts that import the plugin by name

A few scripts deliberately import the plugin **by its package name** (`dsh-plugin-local-offload`) so they exercise the same resolution DSH uses, rather than reaching into `lib/` by path. Those, and the ones that import `@deepseek-ai/dsh-llm-pi-ai`, need a `node_modules` entry. One command creates them by pointing at the harness already on your machine — no install, and no administrator rights:

```sh
node tools/setup-dev.mjs           # create the links
node tools/setup-dev.mjs --status  # report only, change nothing
```

It links `node_modules/@deepseek-ai` to the harness's own copy and `node_modules/dsh-plugin-local-offload` to this checkout. `node_modules/` is gitignored, so nothing reaches the repository. If linking is blocked on Windows, the script prints the two `mklink /J` lines that do the same job without needing a privilege.

Everything else runs without that step. The nine scripts that need it are `verify-live.mjs`, `verify-all.mjs`, `verify-route.mjs`, `test-credentials.mjs`, `test-plugin.mjs`, `test-defer.mjs`, `test-race.mjs`, `test-selfheal.mjs`, `test-payload-guard.mjs`, `test-rotation-live.mjs` and `test-siliconflow.mjs`. Each of them prints `node tools/setup-dev.mjs` when the import fails, so a fresh clone tells you what to do rather than failing with a bare `ERR_MODULE_NOT_FOUND`.

### Why there are two verification scripts

`test/verify-all.mjs` is the richer one: it validates the route against the harness's own `Config` schema and compares the installed plugin copy against the source. It imports harness packages **by bare specifier**, and ES module resolution for a bare specifier is relative to the importing *file's* directory — never the current working directory. A script living outside the DSH installation's own `node_modules` tree therefore cannot resolve them at all, and even dynamic `import()` from the profile directory fails, because the specifiers inside the imported file are still resolved against that file:

```
$ cd ~/.dsh/profiles/web
$ node <repo>/test/verify-all.mjs
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-llm-pi-ai'
```

`node tools/setup-dev.mjs` fixes that by creating the link. `tools/verify-live.mjs` was written as the check that needs no setup at all, so there is always a way to verify the plugin on a fresh clone.

### Tests that skip rather than fail

`test/test-client.mjs` and `test/verify-route.mjs` need the local `llama.cpp` server, which is deliberately **not** auto-started (it occupies VRAM while running, and it is only the fallback). When nothing is listening they print `SKIP` and exit 0, because "the endpoint is absent" and "the endpoint is broken" are different facts and must not look the same. Start it with `powershell -File F:\bonsai\start-local-ai.ps1` and they run for real.

`.github/workflows/ci.yml` runs the offline subset on Node 22.19 and 24, on Linux and Windows, against an **empty** `DSH_HOME` so a developer's real harness home can never influence the result and no check can read a real credential by accident. It is named as code rather than linked because, as the note below explains, that file may legitimately be absent from a published copy — and a link to a missing file is worse than a plain name.

CI deliberately does **not** install the harness. The harness is a moving pre-stable target, and pinning it into CI would produce failures that say nothing about this repository; `tools/doctor.mjs` is the tool for that question, and it is meant to be run by hand against a real installation. CI also does not run `verify-live.mjs`, because that would mean putting an API key into CI secrets for a project whose entire premise is that a free tier and a local model are enough.

> **Why the workflow file may be missing from a published copy.** GitHub refuses to let a personal access token create or update anything under `.github/workflows/` unless that token carries the **`workflow`** scope on top of `repo`. A push including the file is rejected as a whole, and removing it from the newest commit does not help, because a push sends history. If you clone this repository and `.github/workflows/ci.yml` is absent, that is why: add the token scope and push it. [`docs/troubleshooting.md`](docs/troubleshooting.md) records the exact error text and the fix.

`tools/verify-live.mjs` is the acceptance run. It exercises the source checkout rather than the profile's installed copy, and it asserts one behavioural property in particular: that an `extract` delegation returns **all four** distinct error codes from a synthetic payload. A vague instruction once made an 8B model return two of four and stop, so the exhaustiveness clause in the system prompt is load-bearing and this test keeps it that way.

```sh
node tools/verify-live.mjs            # live, against the configured endpoint
node tools/verify-live.mjs --offline  # registration and contract checks only
```

## Contributing

The most useful contribution is a measurement that contradicts one published here, with the command that produced it. Second most useful: your harness version and `doctor.mjs` output, which is what keeps the compatibility table honest.

## License

[MIT](LICENSE).

## Sponsorship

Optional and non-commercial. If this saved you money, [the tip jar is here](docs/sponsor.md) — including a checklist of platform rules to verify before publishing a payment code.
