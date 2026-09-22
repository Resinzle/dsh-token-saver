# What dsh-token-saver is

**A token-reduction setup for [DSH](https://github.com/deepseek-ai/deepseek-harness) (DeepSeek Harness).** It does not switch models or trade away quality. It reduces **what gets re-sent**.

Written for a technical reader. Plain-language version: [`intro-beginner.en.md`](intro-beginner.en.md) ｜ 中文: [`intro-professional.zh.md`](intro-professional.zh.md)

---

## 1. The problem

A paid agent loop is not billed per conversation. It is billed **per step, and every step re-sends the entire transcript**.

Measured on real session logs with `node test/cost-report.mjs`:

| Measure | Value |
|---|---|
| Requests in one session | **672** |
| Prompt tokens that session | **287,481,671** |
| Median prompt size per request | **252,044 tokens** |
| Cache hit rate, all sessions | **99.3%** |

**The cache does not rescue this.** 99.3% of prompt tokens were cache hits, and **50.0% of the bill was still cached input** — because cached input is billed.

> The money is not in how much *new* text the model read. It is in how many times the accumulated history was re-sent.

Get that wrong and every optimisation that follows aims at the wrong target.

## 2. The approach

```
cost  ≈  (average context size)  ×  (number of requests)
```

Both factors are controllable, and this project attacks both:

| Mechanism | What it does | Measured effect |
|---|---|---|
| **Tool-output spill** | A tool result above a byte threshold is replaced, **before it enters context**, by a head/tail preview plus a locator naming a file on disk. The full text stays retrievable with `read`/`grep`. | The shipped 50 KB threshold fired on **1 of 1,918** results (2.0% of tool text). At **12 KB it captures 39 results, 33.0%**. A verified 60,562-byte output put ~11,600 bytes into the transcript. |
| **Delegation to a free model** | Bulk text is processed by a free endpoint; only the digest enters context. | 2,689 chars in → 74 chars out. A 14,366-char payload → a 122-char answer, and that answer is what gets re-sent from then on. |
| **Automatic rotation on throttle** | When a free endpoint rate-limits, the next model is tried; the local server is the floor. | The per-minute allowance is **per model, not per account** (measured: 429 after 224,713 tokens on one model, then three other free models returned 200 immediately). |
| **Bill measurement** | Four scripts reconstruct where the tokens actually went from the session logs. | Cached input 50.0% / uncached input 18.1% / output 31.8%. |

### Why prevent rather than compress

The intuitive move is to compress once the context fills. Compaction: fires only under pressure, so the bulk has already been replayed for a long time; costs a summarisation call; and **rewrites history, which invalidates the cached prefix from the rewrite point onward**.

Spilling happens **at insert time**. It is append-only, so it does not disturb the reusable prefix, and it calls no model.

### The first lever is actually requests per turn

Measured with `node test/turns-report.mjs`:

| Session | User turns | Requests | Requests/turn | Average context |
|---|---|---|---|---|
| session-5c6c5f60 | 50 | 672 | 13.4 | 427,800 |
| session-42f1524a | 18 | 571 | 31.7 | 339,276 |
| session-bb7d2e5c | 1 | 84 | **84.0** | 92,699 |

Same tooling: one session spent 13.4 requests per turn, another spent **84 requests on a single user turn**. Every redundant tool call re-sends the whole transcript, and this is the factor a user controls directly.

## 3. How it is built

### 3.1 Dependency surface (why it survives upgrades)

The plugin imports **two public packages**:

```js
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
```

It references **no harness-internal module**. The tool definition matches the official tutorial ([`docs/user/develop/basic/tool.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/tool.md)) field for field — `name`, `description`, `parameters`, `output.schema`, `output.render`, `execute` — registered through `ctx.tools.register` with `inject = ['tools']`.

The configuration layer patches four pre-existing rows by id:

| Row id | Owner | Change | If renamed |
|---|---|---|---|
| `spill-policy` | `@deepseek-ai/dsh-base` | `maxInlineBytes: 50000 → 12000` | patch no-ops, shipped behaviour returns |
| `session-title-llm` | `@deepseek-ai/dsh-base` | title generation moves to a free route | same |
| `session-query-sqlite` | `@deepseek-ai/dsh-base` | shipped is `:memory:` + `openAt: never`; made durable with `first-search` | same |
| `local-offload` | this plugin's own `cordis.yml` | the plugin's own row | the plugin does not load at all |

**The failure mode is silent degradation, not a crash.** The first three being renamed means the patch is inert and DSH falls back to shipped defaults; the plugin's own API changing means a loud load failure. `tools/doctor.mjs` checks both classes.

### 3.2 What the plugin does

It registers one tool, `local_delegate(task, instruction, text, maxTokens?)`, with seven task contracts: `summarize` / `extract` / `classify` / `translate` / `rewrite` / `answer` / `code`.

Three design decisions were forced by measurement, not chosen for style:

**1. The payload ceiling is derived from the endpoint's token window, not a character count.** Chinese costs roughly one token per character and English about one per four, so no character cap bounds both. A 30,000-character Chinese payload killed a running `llama-server`, surfacing only as `fetch failed`. The guard now clamps against `n_ctx × 0.75 − output budget`, with a hard cap of 7,000 tokens per call — measured, a single 50,000 TPM allowance absorbed only **19 full-size calls**, so one call must not spend a minute's quota.

**2. The exhaustiveness clause in the system prompt is load-bearing.** Same payload, same task kind: with a vague instruction an 8B model returned **2 of 4** error codes and stopped; with an explicit demand to cover everything, three consecutive runs returned all 4. `test/verify-live.mjs` asserts this property specifically.

**3. Rotation applies only to retryable errors.** A 429 or an unreachable endpoint advances the chain; a 401 (credential rejected) is reported immediately, because the same bad key fails identically on every endpoint and retrying five of them only wastes time.

### 3.3 One harness detail you must know

**The harness does not export `.credentials.yaml` into `process.env`.** Verified across the installed harness: the only two writers of `process.env` are `dsh-app-boot`, which materializes `.env` **files** (a different store), and `dsh-http-proxy`.

So a plugin reading only `process.env[apiKeyEnv]` gets `undefined`, sends the placeholder, and receives **HTTP 401 on every delegation**. The first release of this project did exactly that — configuration looked correct and had never worked.

Resolution is now: **environment variable → `credentialsFile` → literal value (with a warning)**, evaluated **per request**, so a key saved after DSH starts is picked up without a restart.

> If you port this to another harness, **verify this first**.

### 3.4 Privacy and data flow

- Spilled full text **stays on the local disk** (under the system temp directory) and is not sent anywhere extra.
- A delegation sends only the `text` **you** pass to the configured endpoint. With local llama.cpp nothing leaves the machine; with a hosted free endpoint that text does leave it, which is a judgement call you have to make for your own data.
- The plugin sets `enable_thinking: false` in the request body and strips `<think>` blocks from the response, because reasoning tokens are both useless and billed.

## 4. Version compatibility (stated honestly)

| Harness version | Status |
|---|---|
| `0.1.5-rc.2` | **Verified** — developed and measured on it |
| `master` (at time of writing) | **API checked** — all four row ids present, `defineTool` signature matches |
| Later versions | **Untested** — not known-broken, simply not verified |
| `0.1.2-alpha.*` / `0.1.3-alpha.*` / `0.1.5-alpha.*` | **Not supported** |

Run `node tools/doctor.mjs` after any upgrade: no dependencies, exit code is non-zero when something broke, and it reports its own section list so you can see what was covered. It checks the harness version, the `defineTool` API surface, the four config row ids, whether the delegated credential actually resolves, whether the installed copy matches what the package ships, the import surface, and both encoding rules. Repair paths, and a section on **rebuilding all four mechanisms from scratch if this plugin never works again**, are in [`compatibility.md`](compatibility.md).

## 5. What it does not do

- It does **not** lower the price per token, and it does not switch your main model.
- It does **not** implement spill. Spill happens inside the harness; the plugin cannot influence it. This project measures and configures it.
- It does **not** turn a paid model into a free one. The paid model stays primary; the goal is to spend fewer of *its* tokens.
- It does **not** require a GPU in the hosted configuration. The local `llama.cpp` server is the floor of the rotation chain, not a prerequisite.

## 6. Known costs

- Local prefill is slow **on low-VRAM hardware**: measured **about one second per 1,000 characters** on this machine (**Radeon RX 5700, only 8 GB of VRAM**; 4 K tokens ≈ 33 s, 8 K ≈ 113 s, 14 K ≈ 300 s), which is where the ~6,000-characters-per-call guidance comes from. This is a property of the hardware rather than of `llama.cpp`: the model and its KV cache both have to fit in 8 GB, which is close to the worst case. A machine with more VRAM will be materially faster — re-measure with `test/bench.mjs` rather than carrying these numbers over.
- Free allowances are finite: measured 50,000 TPM per model, roughly 300,000 TPM across six free chat models.
- The spill preview is the model's **only immediate view** of that output. Too low a threshold forces a retrieval round-trip; measured, don't go below ~12 KB (`compaction-tool-result-pruner` already acts at 8,192 chars).

## 7. Verify it in two commands

```sh
node tools/doctor.mjs        # environment: config rows, API signatures, dependency surface, encoding
node tools/verify-live.mjs   # end to end: registration, contract, a live delegation, exhaustiveness regression
```

Full measurements with their reproducing commands: [`measurements.md`](measurements.md).
