# Architecture

This document explains what the setup does, why each part exists, and which measurements forced each decision. It is the reference companion to the [README](../README.md); the reasoning behind every individual config value lives in [`templates/`](../templates/README.md) beside the value itself.

## The cost model that motivates everything

A paid agent loop does not make one request per conversation. It makes one request per **step**, and every request carries the entire transcript built so far. Measured from this deployment's own session logs (`node test/cost-report.mjs`):

| Measure | Value |
|---|---|
| Requests in one session | 672 |
| Prompt tokens that session | 287,481,671 |
| Cache hit rate over all sessions | 99.3% |
| Median prompt size per request | 252,044 tokens |

So the bill is not "how much new text did the model read" but "how many times was the accumulated history re-sent". Two consequences follow, and they are the whole design:

1. **Preventing text from entering the transcript is worth far more than compressing it afterwards.** A blob that never enters history is never re-sent. A blob that enters history is re-sent on every later step of the session.
2. **The cache does not rescue this.** 99.3% of prompt tokens are cache hits, and cached input is still billed — measured at 50.0% of the total bill. A high hit rate means the prefix is stable; it does not mean replay is free.

The second lever is the number of steps, which the model controls by using fewer, better-aimed tool calls. Measured requests per turn range from 1.0 to 84.0 (`node test/turns-report.mjs`).

## The four mechanisms

### 1. Spill oversized tool output before it enters context

`@deepseek-ai/dsh-spill-policy` replaces a plain-text tool result larger than `maxInlineBytes` with a head/tail preview plus a locator naming a spill file on disk. The full text stays retrievable with `read offset/limit` or `grep`.

The shipped value in `@deepseek-ai/dsh-base` is `maxInlineBytes: 50000`. Measured over this deployment's tool results, that threshold almost never fires:

| Threshold | Results spilt | Share of all tool text |
|---|---|---|
| 50,000 chars (shipped) | 1 | 2.0% |
| 12,000 chars (this setup) | 39 | 33.0% |
| 8,192 chars (shipped tool-result pruner) | 65 | 42.7% |

That table is the single largest measured saving in the setup, and it is a **configuration** change, not plugin code. The plugin does not implement spill and cannot: spill happens inside the harness, before a result reaches the transcript.

Why 12,000 and not lower: the preview is the model's only immediate view of that output. A lower cap forces a retrieval round-trip on results that are often read once and never needed again. `read` results are exempt from the policy by design, so reading source files is unaffected at any cap.

### 2. Delegate bulk text to a free model

`local_delegate` is the plugin's contribution. It hands a payload to any OpenAI-compatible Chat Completions endpoint and returns only the compact answer, so the bulk never becomes history.

Seven task contracts select a fixed system instruction: `summarize`, `extract`, `classify`, `translate`, `rewrite`, `answer`, `code`. A verified delegation turned a 14,366-character payload into a 122-character answer, and that answer is what the paid model re-sends from then on — a reduction of roughly two orders of magnitude in the replayed volume.

Two design decisions inside the tool are measured, not stylistic:

- **The exhaustiveness clause.** With a vague instruction ("list the distinct error codes and count the lines") an 8B model returned 2 of 4 codes and stopped. With the same payload and an explicit demand to cover everything, three consecutive runs returned all 4. The instruction's insistence, not the model's size, decided the result. `test/verify-all.mjs` asserts this stays true.
- **The payload ceiling is derived from the endpoint's token window, not a character count.** Chinese costs roughly one token per character and English about one per four, so no single character cap bounds both. A 30,000-character Chinese payload killed a running `llama-server`; the only symptom was `fetch failed`. The tool estimates tokens pessimistically for non-ASCII text and clamps against `n_ctx * 0.75 - outputCap`, additionally capped at 7,000 tokens per call so one call cannot consume a whole minute's metered allowance.

### 3. Rotate across free endpoints instead of waiting out a throttle

The free tier's per-minute token allowance is **per model, not per account**. This was the design's open question for a long time, and two earlier attempts failed to trigger a 429 because the probe requests were too small. The measurement that settled it used expensive requests (large prompt, 512 output tokens, thinking forced on):

```
burn target: Qwen/Qwen2.5-7B-Instruct
#20  >>> HTTP 429 after 224,713 tokens in 22s
     50602 "TPM limit reached."

immediately afterwards:
  Qwen/Qwen3-8B              OK
  THUDM/GLM-4-9B-0414        OK
  Qwen/Qwen3.5-4B            OK
```

So a throttled endpoint can be side-stepped in about a second rather than waited out for a minute. `EndpointChain` parks a rate-limited endpoint for a cooldown (65 s, because the allowance is per minute), tries the next, and un-parks automatically — there is no manual reset to forget. Parked endpoints are appended last rather than dropped, because a park is a prediction and the provider may have released the allowance early.

Only rate limits (`429`) and transport failures advance the chain. A rejected credential or a malformed request would fail identically everywhere, so it is reported immediately instead of being retried against five endpoints.

The chain's credential is resolved independently (`chainApiKeyEnv`, defaulting to `apiKeyEnv`) so that a wrong primary key does not take the whole chain down with it. The integration test found that bug; inspection had missed it.

Deliberately excluded from the chain: `THUDM/GLM-Z1-9B-0414` and `deepseek-ai/DeepSeek-R1-0528-Qwen3-8B`. Both ignore `enable_thinking: false` and spend 68–143 output tokens saying one word, which is the opposite of what a mechanical task needs. Detection: a `reasoning_content` field in the response means thinking was not suppressed.

### 4. Measure the bill from the session logs

`test/cost-report.mjs`, `test/profile-report.mjs`, `test/turns-report.mjs` and `test/cache-report.mjs` read the zstd-compressed session logs and report where the tokens actually went. This exists because the intuitive answer is wrong: the money is in replay, not in reading.

## The measurement floor: the local model

The local `llama.cpp` server is the floor of the rotation chain because it has no quota at all. It is a fallback rather than the primary route because it occupies VRAM for as long as it runs and is slower and weaker than the free hosted route.

**Every number in this section is a property of the test machine, not of `llama.cpp`.** The whole point of a local model is that it runs on whatever hardware you have, and the spread across hardware is enormous — a discrete GPU, an integrated one, Apple silicon, or a CPU-only host differ by more than an order of magnitude. The machine here is a **mid-range consumer setup with only 8 GB of VRAM** (Radeon RX 5700, Ryzen 5 5500, Vulkan backend, a ternary 8B quant), which is close to the worst case for this workload: the model plus its KV cache must fit in 8 GB, leaving little room for the cache that makes long contexts fast. Treat the figures below as a **floor to check your own hardware against**, not as what to expect.

When it is used, prefill is the bottleneck and grows worse than linearly with context length:

| Payload | Wall clock (cold cache), on the 8 GB machine described above |
|---|---|
| ~4 K tokens | ~33 s |
| ~8 K tokens | ~113 s |
| ~14 K tokens | ~300 s |

Roughly one second per 1,000 characters *on that machine*. The practical range it implies is ≤ 6,000 characters per call — on hardware with more VRAM and a faster prefill, raise it; benchmark first with `test/bench.mjs`.

On this class of hardware a larger quant is not better either: Qwen3-8B-Q4_K_M (~4.8 GB) leaves too little VRAM for the KV cache and was already slower at 2 K tokens than the ternary quant at 8 K. On a card with 16 GB or more, the tradeoff inverts and the larger quant is the better choice.

## What was tried and rejected

| Direction | Why it was dropped |
|---|---|
| Raising the compaction threshold instead of spilling | Compaction fires under pressure, so the bulk sits in context until the window fills; it costs a summarization call and rewrites history, which invalidates the cached prefix from the rewrite point onward. Spilling at insert time avoids all three. |
| Editing the compaction threshold from `cordis.patch.yml` | Verified ineffective. `dsh-web-app` disables the host-plane `compaction-basic` row, and the row that actually loads is mounted by `dsh-agent-presets`'s `standard` preset inside its own `isolate` subdomain. A by-id patch edits the dead row: `--dump-config` shows the new value and it never loads. Changing it would require copying the whole preset, which is a snapshot that drifts from upstream. |
| Driving free chat web UIs with browser automation | No browser capability in the harness; would need a self-built Playwright stack plus session cookies; violates the platform's terms with a real ban risk; and yields no streaming output. |
| Skipping rotation because "the quota is per account" | Reversed by measurement. The quota is per model; rotation works and is implemented. |
| Semantic retrieval as a resident tool | The mechanism is proven and measured (thresholds separate real answers from noise; 25-line chunks at a 0.3 threshold delivered 5,387 chars/query versus 14,000–28,000 for 60-line chunks), but there was no local corpus that would be queried repeatedly, so a one-time embedding cost would not pay back. Code is kept in `lib/embeddings.js`, `lib/indexer.js`, `lib/vector-store.js`. |

## Dependency surface

The plugin imports exactly two packages:

- `@deepseek-ai/dsh-tools` — `defineTool`
- `@deepseek-ai/schemastery` — the config schema

It references no harness-internal module. Its tool definition matches the official tutorial ([`docs/user/develop/basic/tool.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/tool.md)) field for field: `name`, `description`, `parameters`, `output.schema`, `output.render`, `execute`, registered through `ctx.tools.register` with `inject = ['tools']`.

The configuration layer patches four pre-existing row ids and inserts one of its own:

| Row id | Owned by | Risk if renamed |
|---|---|---|
| `session-title-llm` | `@deepseek-ai/dsh-base` | patch no-ops, titles return to the paid route |
| `spill-policy` | `@deepseek-ai/dsh-base` | patch no-ops, the 50 KB shipped cap returns |
| `session-query-sqlite` | `@deepseek-ai/dsh-base` | patch no-ops, search returns to `:memory:` + `openAt: never` |
| `local-offload` | this plugin's own `cordis.yml` | the plugin does not load at all |

Every one of those failures is a **silent fallback to shipped behaviour**, not a crash. `tools/doctor.mjs` checks each one against the installed harness so the fallback is detected rather than discovered later.

## See also

- [measurements.md](measurements.md) — the raw numbers, with the command that produces each
- [compatibility.md](compatibility.md) — which harness versions are verified, and what to do after an upgrade breaks something
- [troubleshooting.md](troubleshooting.md) — failure modes and their fixes
