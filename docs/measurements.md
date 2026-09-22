# Measurements

Every number here was produced on the machine that developed this setup, by the named command, and can be reproduced. Nothing in this file is an estimate unless it says so. Where a figure differs from an earlier hand-written note, the value below is the one the command currently prints.

Reproduce all of them:

```sh
node test/cost-report.mjs        # billing attribution and cache hit rate
node test/profile-report.mjs     # tool-output volume and per-request prompt size
node test/turns-report.mjs       # requests per human turn
node test/cache-report.mjs       # per-session cache and compaction counts
```

All four read `$DSH_HOME/sessions` (default `~/.dsh/sessions`) and accept an optional root and file-count argument.

## The full picture, all sessions

`node test/cost-report.mjs`:

```
cached input (cache hit)        529,483,910 tok   $1.588   (50.0%)
uncached input (cache miss)       3,835,345 tok   $0.575   (18.1%)
output                            1,684,410 tok   $1.011   (31.8%)
TOTAL                           535,003,665 tok   $3.174

cache hit rate: 99.3%
reasoning tokens inside output: 657,777 (39.1% of output)
total requests: 1,715

per-request prompt size: min 9,402  p50 252,044  p90 661,726  p99 783,753  max 795,213
requests above 100K prompt tokens: 1,326 / 1,715
requests above 200K prompt tokens: 1,004 / 1,715
```

Two readings matter more than the total:

- **50.0% of the bill is cache hits.** The cache is working (99.3%) and the money is still being spent, because cached input is billed. A high hit rate is not a saving by itself.
- **The median request carries 252,044 prompt tokens.** Most of that is history being re-sent, not new material.

## Requests per human turn

`node test/turns-report.mjs`:

| Session | Turns | Requests | Requests/turn | Average context |
|---|---|---|---|---|
| `session-5c6c5f60` | 50 | 672 | 13.4 | 427,800 |
| `session-42f1524a` | 18 | 571 | 31.7 | 339,276 |
| `session-9756e0cc` | 5 | 93 | 18.6 | 128,995 |
| `session-bb7d2e5c` | 1 | 84 | 84.0 | 92,699 |
| `session-a40c6c0c` | 7 | 84 | 12.0 | 151,800 |
| `session-16fed289` | 6 | 80 | 13.3 | 144,981 |
| `session-8ca65d2e` | 1 | 57 | 57.0 | 92,146 |
| `session-add93442` | 5 | 37 | 7.4 | 31,577 |
| `session-721c7356` | 1 | 34 | 34.0 | 84,944 |

Session totals: 13 sessions, 99 turns, 1,728 requests, **17.5 requests/turn**, 535,036,192 prompt tokens.

The two extremes are the lesson. `session-5c6c5f60` used 13.4 requests per turn over 50 turns — the model worked in deliberate steps. `session-bb7d2e5c` used **84 requests for a single user turn**. Both cost real money, but only one of them was decided by the user's request.

The prompt-token total from this script (535,036,192) and from `cost-report.mjs` (535,003,665) differ by 0.006% because `cost-report.mjs` skips two sessions whose logs contain usage records but no `turn/start`. They agree to within rounding, which is the cross-check that the parsers are reading the same events correctly.

## Tool-output volume, and why the spill cap matters

`node test/profile-report.mjs`:

```
results: 1,918   text: 2.68 M chars
above 50,000 chars (shipped spill cap):  1 result,  0.05 M chars ( 2.0%)
above 12,000 chars (this setup):        39 results, 0.88 M chars (33.0%)
above  8,192 chars (shipped pruner):    65 results, 1.14 M chars (42.7%)
```

The shipped `maxInlineBytes` of 50,000 fires on **one** result out of 1,918. Lowering it to 12,000 captures **39 results carrying 33.0% of all tool text**. That is the single largest measured saving available in this setup, and it is configuration, not plugin code.

The 0.88 M chars are an upper bound on what leaves context: a spill keeps a head/tail preview, and the model can read the spill file when the middle matters.

## A verified spill

Measured on one command output of **60,562 bytes**. The transcript received approximately **11,600 bytes** — a head/tail preview plus a locator line:

```
(Omitted 48915 bytes. Full formatted result stored at:
 C:\...\dsh-spill-gbwoOj\session-...\79ff7bc02d61-pwsh.txt)
```

The full text remained readable with `read offset/limit` and searchable with `grep`. Spilling is append-only with respect to the cached prefix: it does not invalidate reusable history the way rewriting the transcript does.

## Free-tier quota is per model, not per account

The measurement that the rotation chain depends on. Expensive requests (large prompt, 512 output tokens, thinking forced on) against one model until it throttled, then three other free models immediately afterwards:

```
burn target: Qwen/Qwen2.5-7B-Instruct
#20  >>> HTTP 429 after 224,713 tokens in 22s
     50602 "TPM limit reached."

immediately afterwards:
  Qwen/Qwen3-8B              OK
  THUDM/GLM-4-9B-0414        OK
  Qwen/Qwen3.5-4B            OK
```

A single 50,000 TPM allowance absorbed only **19 requests of that size**, which is why the plugin caps one delegation at roughly 7,000 tokens: one call must not spend a whole minute's quota.

## Free-model selection

Six free chat models were probed with a minimal request, each costing 1–2 output tokens:

| Model | Context | TPM | Measured latency | Output tokens | Verdict |
|---|---|---|---|---|---|
| `Qwen/Qwen2.5-7B-Instruct` | 32K | 50K | 0.5 s | 1 | mechanical work |
| `THUDM/GLM-4-9B-0414` | 32K | 50K | 0.9 s | 2 | mechanical work |
| `Qwen/Qwen3-8B` | 128K | 50K | 1.2 s | 1 | mechanical work |
| `Qwen/Qwen3.5-4B` | 256K | 80K | 10.0 s | 1 | long context only (slow) |
| `THUDM/GLM-Z1-9B-0414` | 128K | 50K | 2.5 s | **68** | rejected: thinking cannot be disabled |
| `deepseek-ai/DeepSeek-R1-0528-Qwen3-8B` | 128K | 50K | 4.8 s | **143** | rejected: thinking cannot be disabled |

The two reasoning models ignore `enable_thinking: false`. Asking one of them to say a single word costs 68–143 output tokens. Detect it by the presence of a `reasoning_content` field in the response.

## Instruction strength decides exhaustiveness

Same payload, same task kind, different instruction:

| Instruction | Result |
|---|---|
| "list the distinct error codes and count the lines" | 2 of 4 codes returned, then stopped |
| explicit demand to cover the entire payload | all 4 codes, on 3 consecutive runs |

This is why the `extract` system instruction states its exhaustiveness requirement at length, and why `test/verify-all.mjs` asserts all four codes come back.

## The local model is the floor, and on this hardware it is slow

**Read the device line as part of the result.** These figures come from a mid-range consumer machine with only **8 GB of VRAM**, so the model and its KV cache have to share that — close to the worst case for this workload. A local model's speed is a property of the hardware it runs on, and hardware spans more than an order of magnitude from a CPU-only host to a discrete GPU with plenty of VRAM. Do not carry these numbers to another machine; measure there with `test/bench.mjs`.

Device: **Radeon RX 5700 (8 GB VRAM) + Ryzen 5 5500, Vulkan backend, ternary 8B quant, cold cache.**

| Payload | Wall clock |
|---|---|
| ~4 K tokens | ~33 s |
| ~8 K tokens | ~113 s |
| ~14 K tokens | ~300 s |

Roughly one second per 1,000 characters **on that machine**. On hardware with more VRAM and faster prefill, expect materially better; the 6,000-characters-per-call guidance elsewhere is derived from these figures and should be re-derived per machine.

## Embeddings are metered in tokens

`BAAI/bge-m3` counted approximately **1.4 tokens per character**. Indexing 0.70 M characters cost about **200,000 embedding tokens** and roughly 100 s. The 500,000 TPM embedding allowance looks generous until a multi-megabyte corpus has to be indexed across several minutes.

Also measured in that prototype: a corpus the answer was not in scored **0.001** with a relevance threshold and returned zero chunks; the same query without a threshold returned 24,000 characters of noise. Real answers scored 0.56–0.91. A threshold of 0.3 separates them.

One design rule came out of a failure: the first indexer wrote only at the end, and a run that failed partway discarded 250,000 tokens of already-paid embeddings. Persist after every batch.

## What the plugin itself is worth, stated honestly

Auxiliary model calls — session titles, compaction summaries — were **already negligible** before anything was changed. The 2.58 M tokens in the largest session measured here are 672 main-loop requests replaying accumulated history. So:

- **Spill and delegation are the real levers.** They keep bulk text out of history entirely.
- **Routing the session-title call to a free model is a small, free win.** It removes a paid request per session. It is configured, not oversold.
- **Compaction was deliberately left on the paid route.** Its summarizer replays the conversation prefix verbatim, which would be slow on a local model, and a session containing images would fail outright because the local models declare text-only input.
