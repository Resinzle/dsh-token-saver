# Version compatibility

This setup touches the harness in exactly two ways: a plugin that registers one tool, and a configuration patch that overrides four existing rows. This page records which harness versions those two interfaces were verified against, how to re-check after an upgrade, and what to do when something breaks.

## Verified range

| Harness version | Plugin API | Config row ids | How it was verified |
|---|---|---|---|
| `0.1.5-rc.2` | present | present | Inspected the installed packages on the development machine |
| `master` (as of this checkout) | present | present | Read from the official repository: `packages/dsh-tools/lib/types/schema.d.ts`, `packages/bundle/base/cordis.patch.yml`, `docs/config-catalog.md` |

**Minimum supported: `0.1.5-rc.2`.** The plugin was written and measured on it. **Higher versions are untested** — not known-broken, simply not verified. Run `tools/doctor.mjs` after any upgrade; it resolves what your installation actually contains rather than trusting this table.

Earlier versions (`0.1.2-alpha.*`, `0.1.3-alpha.*`, `0.1.5-alpha.*`) exist and are **not** supported. `0.1.2-alpha` was an architecture refactor with a documented plugin-compatibility notice, and this plugin has never been tested against it. If you are on an alpha, upgrade first.

## What "compatible" means here, precisely

The plugin uses only two public imports:

```js
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
```

and registers through the documented extension point:

```js
export const name = 'local-offload'
export const inject = ['tools']
export function apply(ctx, config) {
  ctx.tools.register(defineTool({ /* name, description, parameters, output, execute */ }))
}
```

This is field-for-field the shape in the official tutorial, [`docs/user/develop/basic/tool.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/tool.md). `defineTool`'s options in `0.1.5-rc.2` are `name`, `description`, `parameters`, `output`, `timeoutMs`, `isConcurrencySafe`, `execute` — all of which this plugin uses, and none of which it uses in an undocumented way.

The four patched row ids and their shipped owners:

| Row id | Shipped by | Shipped config | What this setup changes it to |
|---|---|---|---|
| `session-title-llm` | `@deepseek-ai/dsh-base` | paid route, no `provider`/`model` override | `provider: siliconflow`, `model: Qwen/Qwen3-8B` |
| `spill-policy` | `@deepseek-ai/dsh-base` | `maxInlineBytes: 50000` | `maxInlineBytes: 12000` |
| `session-query-sqlite` | `@deepseek-ai/dsh-base` | `path: ':memory:'`, `openAt: never` | a durable path, `openAt: first-search` |
| `local-offload` | this plugin's `cordis.yml` | — | the plugin's own row |

The first three are verified present in `@deepseek-ai/dsh-base`'s `cordis.patch.yml` and documented in the official `docs/config-catalog.md`. The fourth is inserted by this plugin, so it exists exactly when the plugin loads.

## Failure modes, ranked by likelihood

| What changes upstream | Effect here | Severity |
|---|---|---|
| A row id is renamed | That one patch silently stops applying; shipped behaviour returns | **Silent, degraded** |
| A config key is renamed | Same: the patch applies but the value is ignored | **Silent, degraded** |
| `defineTool`'s options change | The plugin throws at load; the tool is absent | **Loud** |
| `@deepseek-ai/dsh-tools` is renamed or restructured | Node cannot resolve the import; the plugin throws at load | **Loud** |
| `inject = ['tools']` stops being the way to reach the registry | The plugin never activates | **Loud** |

The distinction matters: plugin-code breakage announces itself, configuration breakage does not. After an upgrade, the thing to check is not whether DSH starts — it is whether the four rows still apply.

## Re-checking after an upgrade

```sh
node tools/doctor.mjs
```

No arguments, no dependencies, and no DSH running required for the parts that inspect files. It reports, and exits non-zero when something is wrong:

1. Which harness version is installed and where.
2. Whether each of the four row ids still exists in the installed bundles.
3. Whether `defineTool` is still exported and whether its option names still match what the plugin uses.
4. Whether the plugin's own imports are all public packages (the dependency-surface audit).
5. Whether the profile patch sets each of the four values.
6. Whether the installed plugin copy is byte-identical to the source checkout.
7. Whether `~/.dsh` contains any BOM-damaged JSON, which bricks DSH startup for reasons unrelated to this plugin.

## If a row id is gone

The patch is inert, DSH still starts, and you have lost one mechanism. The fix is a one-line edit in your profile's `cordis.patch.yml`: find the new id and rename the key.

```sh
# what the row ids are now
grep -rn "maxInlineBytes\|session-title\|session-query" ~/.dsh/profiles/*/cordis.patch.yml
dsh --profile <name> --dump-config | grep -A2 spill-policy
```

If `--dump-config` shows your value and the behaviour still does not change, the row is probably disabled by a later bundle, the way `dsh-web-app` disables the host-plane `compaction-basic` row. A by-id patch edits the disabled row and never takes effect. Check the bundle patches for `disabled: true` on that id.

## If `defineTool` changed

The plugin will fail to load, and the failure names the missing export or the rejected option. Two repairs, in order of preference:

1. **Update the plugin call site** to the new option names. The plugin has three files that matter: `lib/tools.js` (the tool definition), `lib/index.js` (`Config` schema and `apply`), `lib/rotation.js` (pure logic, no harness imports — it will not need changes).
2. **Keep the idea, drop the code.** See below.

## The durable part: how to rebuild this without this plugin

If the plugin never works again, the four ideas below are independent of any API and can be reimplemented on whatever extension point exists. This section is written so that it survives this repository.

**1. The cost model.** A paid agent loop re-sends the entire transcript on every step, so the bill is (average context) × (number of requests), not (new text read). Verify it on your own logs before doing anything else; if your numbers do not look like this, the rest of the advice does not apply to you.

- Find your session logs: `$DSH_HOME/sessions/*/session.v*.jsonl.zstd`.
- They are zstd streams concatenated with magic bytes `28 b5 2f fd`. `test/cost-report.mjs` in this repository shows the decode: scan for the magic, decompress each frame, parse the JSON lines. Node's `zlib.zstdDecompressSync` handles each frame.
- Per request, the usage record carries `inputTokens` (the UNCACHED portion), `cacheReadTokens` (the reused prefix), `outputTokens`, and `reasoningTokens`. The real prompt size is `inputTokens + cacheReadTokens`; dividing `cacheReadTokens` by `inputTokens` alone produces nonsense above 100%.
- Per turn, count `turn/start` records. Do not infer turns from user-role messages: the record type is `user/message`, and tool results and `agent/inbox/spliced` injections also live on the user side.

**2. Keep bulk text out of the transcript.** Whatever the mechanism is called, the rule is the same: a large blob must be summarised *before* it becomes history, not compressed after. If your harness has an output-spill or output-limit setting, set it low — the shipped 50 KB limit in DSH fired on 1 result out of 1,918 in this deployment, which is indistinguishable from off. If it has no such setting, the equivalent move is to make every large read go through a summariser first.

**3. Never let a free-tier throttle stop work.** The load-bearing fact is that per-minute token allowances are usually **per model, not per account** — verify it for your provider by exhausting one model and immediately calling another. If it holds, a throttled model can be side-stepped in about a second instead of waited out for a minute. If it does not hold for your provider, rotation is worthless and you should not build it.

**4. Reduce steps, not just bytes.** Measured here: the same work was done at 13.4 requests/turn in one session and 84 requests/turn in another. Every tool call replays the whole transcript. Fewer, better-aimed calls; no re-reading the same file; no exploratory probing.

## Upstream references

- [Build a tool](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/tool.md) — the official tutorial this plugin follows
- [Publish a plugin](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md) — profile installation, bundle loading order, and the git-install build-script caveat
- [Config catalog](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.md) — the generated reference for every plugin's config type
- [Network proxy](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/network-proxy.md) — how DSH reads `HTTPS_PROXY`, and what stays direct
- [Repository `AGENTS.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/AGENTS.md) — includes the rule that deployment-varying choices must be validated `Config` fields, which is the convention this plugin follows
