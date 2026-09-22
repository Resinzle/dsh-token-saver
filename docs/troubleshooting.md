# Troubleshooting

Each entry names the symptom you will actually see, the cause, and the fix. The plugin's error messages are written to be self-diagnosing, so start by reading the message: it names the endpoint, the model, and the HTTP status.

## `HTTP 429` from `local_delegate`

**Cause.** The free tier's per-minute token allowance for *that model* is spent. This is expected under sustained use, not a bug.

**What the plugin already did.** It parked that endpoint for `cooldownSeconds` (65 s by default, because the allowance is per minute) and tried the next entry in `chain`. If you are seeing the error at all, the whole chain was exhausted — including the local server at the end of it.

**Fixes, in order:**

1. Wait a minute. Parked endpoints un-park automatically; there is no state to reset.
2. Check that the chain is configured at all. With an empty `chain` there is nothing to rotate to:
   ```sh
   dsh --profile <name> --dump-config | grep -A6 local-offload
   ```
3. Check whether the local fallback is running. It has no quota and is the last entry precisely so that the chain cannot run dry:
   ```sh
   curl -s http://127.0.0.1:18080/health
   ```
4. Make fewer, larger delegations. One call is capped at roughly 7,000 tokens on purpose, because a single 50,000 TPM allowance absorbed only 19 full-size calls in measurement.

**Do not** retry in a tight loop. The allowance is per minute; retrying inside the window burns latency and returns the same 429.

## `HTTP 401` or `403`

**Cause.** The credential was rejected. Rotation does **not** apply here, by design: the same bad key fails identically on every endpoint, so the plugin reports it immediately instead of trying five more.

**Read this first: a 401 with a key you know is correct is usually not a bad key.** The harness keeps saved keys in `<DSH_HOME>/.credentials.yaml` and resolves them for **its own** routes on demand; it never exports them into the process environment. Verified against the installed harness: the only two writers of `process.env` are `dsh-app-boot`, which materializes `.env` **files** (a different store), and `dsh-http-proxy`. A plugin reading only `process.env[apiKeyEnv]` therefore sees `undefined` and sends the placeholder, which is precisely the bug this project shipped and fixed: every hosted delegation failed with a 401 while the same key worked fine in the DSH Models page.

The plugin now resolves the credential itself, per request: the environment variable first, then the file named by `credentialsFile`, then the literal `apiKey` with a warning. Confirm which source it found:

```sh
node tools/verify-live.mjs --offline
```

It prints `credential SILICONFLOW_API_KEY: launch environment | the credential file | RESOLVES NOWHERE`.

**Fixes:**

1. Confirm the key exists and is not the placeholder:
   ```sh
   grep -A2 SILICONFLOW_API_KEY ~/.dsh/.credentials.yaml
   ```
2. Make sure the plugin is told where that file is. The default is `<DSH_HOME>/.credentials.yaml`; if your harness home is elsewhere, set it explicitly in the profile patch:
   ```yaml
   - id: local-offload
     config:
       apiKeyEnv: SILICONFLOW_API_KEY
       credentialsFile: !!js dshHomePath('.credentials.yaml')
   ```
3. To override the file with a real environment variable, export it before starting DSH — the launch environment still wins. Verify with:
   ```sh
   node -e "console.log(process.env.SILICONFLOW_API_KEY ? 'set (' + process.env.SILICONFLOW_API_KEY.length + ' chars)' : 'NOT SET')"
   ```
   Note that a key saved into `.credentials.yaml` **after** DSH started is still picked up, because resolution repeats per request; an environment variable is read from the process, so it needs a restart.
4. If the chain spans hosts with different keys, set `chainApiKeyEnv` separately. The chain resolves its own credential on purpose, so a wrong primary key does not take the fallbacks down with it.
5. Confirm the key is accepted at all, independently of this plugin:
   ```sh
   node -e "fetch('https://api.siliconflow.cn/v1/models',{headers:{authorization:'Bearer '+process.env.SILICONFLOW_API_KEY}}).then(r=>console.log(r.status))"
   ```

## The tool is not in the tool list at all

**Cause.** The plugin did not load. The most common reason is that the installed copy is stale, because a `file:` install copies rather than links.

**Fixes:**

```sh
# 1. is the plugin in the profile at all?
cat ~/.dsh/profiles/<name>/package.json

# 2. does the installed copy match your source checkout?
node tools/doctor.mjs

# 3. reinstall and restart DSH
dsh plugin --profile <name> add ./dsh-token-saver
```

DSH reads a profile's bundle list once at composition time, so **the plugin only appears after the DSH server restarts**, not after a page reload.

If your installation is a symlink (`link:` rather than `file:`), edits to the source take effect on restart without reinstalling.

## The config values look right but nothing changed

**Cause.** Almost always one of two things.

**A later layer replaced your whole `config`.** A patch replaces the targeted row's entire `config`; it does not deep-merge. If a bundle patch or a home-level `~/.dsh/cordis.patch.yml` also targets that row id, it wins and restates every key — so a value you set can vanish without any error. Layer order, later wins:

1. each bundle in `dsh.profile.bundles`, in list order
2. the profile's own `cordis.patch.yml`
3. `$DSH_HOME/cordis.patch.yml`
4. each `--patch <path>` overlay, in argv order

Always restate the complete config for a row you patch.

**The row you patched is disabled and never loads.** Verified case: `dsh-web-app` disables the host-plane `compaction-basic` row, and the row that actually loads is mounted by `@deepseek-ai/dsh-agent-presets`'s `standard` preset inside its own `isolate` subdomain. A by-id patch edits the dead row — `--dump-config` shows your value and it never takes effect. Check for `disabled: true` on the id in the bundle patches.

## Spill never happens

**Cause.** `maxInlineBytes` is missing, or too high.

An absent `maxInlineBytes` is a **true no-op**: `@deepseek-ai/dsh-spill-policy` registers nothing. The shipped value in `@deepseek-ai/dsh-base` is `50000`, which in measurement fired on 1 result out of 1,918.

**Fix.** Set it and confirm it is what you think:

```sh
dsh --profile <name> --dump-config | grep -B2 -A2 maxInlineBytes
```

The spilled full text is on disk; the locator line names the path. Read it back with `read offset/limit` or search it with `grep`. `read` results are exempt from the policy, so lowering the cap does not affect reading source files.

## DSH will not start at all after editing a profile file

**Cause.** A UTF-8 BOM at the start of a `.json` file. DSH reads the profile manifest with `readFileSync(path, 'utf8')` followed by `JSON.parse`, and `JSON.parse` rejects a leading BOM. On Windows PowerShell 5.1, `Set-Content`/`Out-File -Encoding utf8` writes exactly that BOM.

This is not hypothetical: an earlier revision of this project's own install script caused it, and DSH could not recover on its own.

**Check and fix:**

```sh
node test/check-bom.mjs
```

The rule points in two directions and both matter:

- **data files (`.json`) must NOT have a BOM**
- **`.ps1` scripts containing non-ASCII text MUST have a BOM**, or PowerShell 5.1 reads them as GBK and mangles them

The safest option for scripts is to keep them pure ASCII. To write JSON from PowerShell without a BOM:

```powershell
[System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
```

Installing with `dsh plugin add` avoids the problem entirely, because pnpm writes the manifest.

### The BOM rule bites in the other direction too

Losing a BOM is just as damaging as gaining one, and it is easier to do by accident: **many editors and programmatic rewrites drop a BOM without saying so.** This actually happened here. Removing the launcher's auto-start stripped the BOM from `dsh-launcher.ps1`, and Windows PowerShell 5.1 then reported:

```
The string is missing the terminator: '.
```

The file was not corrupt — it was still valid UTF-8 with 366 intact CJK characters — but PowerShell read it as GBK, where a Chinese character's trailing byte can be a quote, which breaks string parsing. **The launcher would simply have stopped working.** Restoring the three bytes `EF BB BF` fixed it with no other change.

`tools/doctor.mjs` now checks this: any `.ps1` containing non-ASCII bytes must start with a BOM, or that check FAILS. Restore one with Node, never with PowerShell:

```sh
node -e "const fs=require('node:fs');const p=process.argv[1];const t=fs.readFileSync(p,'utf8');if(t.charCodeAt(0)!==0xFEFF)fs.writeFileSync(p,'\uFEFF'+t,'utf8')" <file.ps1>
```

Point the check at a launcher outside `$DSH_HOME` with `DSH_LAUNCHER`:

```sh
DSH_LAUNCHER=/path/to/dsh-launcher.ps1 node tools/doctor.mjs
```

## `local_delegate` returns an empty answer

**Cause.** The model spent its entire output budget on reasoning tokens. The error message says so and reports `finish_reason`.

**Fix.** Raise `maxTokens` for that call, or send a smaller payload. Note that two free models — `THUDM/GLM-Z1-9B-0414` and `deepseek-ai/DeepSeek-R1-0528-Qwen3-8B` — ignore `enable_thinking: false` entirely and will do this on every call. They are excluded from the shipped chain for this reason. Detect the condition by a `reasoning_content` field in the raw response; the plugin strips `<think>` blocks from the text but cannot recover a budget already spent.

## The answer is incomplete — the model stops early

**Cause.** Not enough insistence in the instruction. Measured: with a vague instruction ("list the distinct error codes and count the lines") an 8B model returned 2 of 4 items and stopped; with an explicit demand to cover the entire payload it returned all 4, three runs in a row.

**Fix.** The `extract` task already carries a long exhaustiveness clause in its system instruction. Do not shorten it. Put the completeness requirement in the `instruction` argument too, and name the shape you want ("every distinct code, comma separated, nothing else").

## A delegation takes minutes

**Cause.** You are on the local `llama.cpp` fallback, where prefill is the bottleneck and grows worse than linearly with context length.

**How bad depends entirely on your hardware**, so calibrate against this before concluding anything. Measured on an **8 GB VRAM consumer setup** (Radeon RX 5700 + Ryzen 5 5500, ternary 8B quant): ~33 s at 4 K tokens, ~113 s at 8 K, ~300 s at 14 K — roughly one second per 1,000 characters. Eight gigabytes is close to the worst case here, because the model and its KV cache share that budget. With more VRAM, or a faster accelerator, expect materially better; with a CPU-only host, worse. Re-measure on your machine with `test/bench.mjs` rather than assuming these.

**Fix.** On hardware like the above, keep payloads at or under ~6,000 characters for the local endpoint. Above ~30,000 characters, slice the text with `grep`/`read offset` first or split it across several calls. Check which endpoint answered: every result ends with a line naming the model and its token counts, and a rotation adds a second line naming the chain state.

## Pushing the repository fails, and the message points at your token

`tools/push-to-github.mjs` reports the two failures that do **not** mean what they look like. Both were met while building this project, and each sends you debugging the token when the token is fine.

### `could not read Username` / an interactive prompt appears

**This is a credential-delivery problem, not a bad token.** git never received a credential, fell through to a prompt, and there was no terminal. Three causes, all of them real:

1. **`credential.helper` values accumulate.** Git runs every configured helper in order. A machine with Git Credential Manager — the default for Git for Windows, and what signing into GitHub from a browser sets up — runs GCM *after* a custom helper, finds nothing, and prompts. An empty `credential.helper=` must come **first** to reset the list:
   ```sh
   git -c credential.helper= -c credential.helper='store --file=<path>' ...
   ```
   Measured without it: the invocation hung past a 120-second timeout.

2. **`git credential-store` does not read the `key=value` format.** That format is what `git credential fill` *speaks*; the store *stores* one URL line per credential. A file written as `protocol=`/`host=` lines never matches.

3. **The URL line has the host exactly once, after the `@`**:
   ```
   https://x-access-token:<token>@github.com/
   ```
   Not `https://github.com/x-access-token:…@github.com`. The authority is what `git credential approve` writes, so compare against it if unsure:
   ```sh
   printf 'protocol=https\nhost=github.com\nusername=u\npassword=p\n\n' | git credential approve
   cat ~/.git-credentials
   ```

Re-run with `--debug-credential` to print the helper value and the credential line with the password replaced.

### `refusing to allow a Personal Access Token to create or update workflow … without 'workflow' scope`

**The push was authenticated.** GitHub refused exactly one file, so the token works — it just lacks a permission.

This repository ships `.github/workflows/ci.yml`. A token may not create or update anything under `.github/workflows/` unless it carries the **`workflow`** scope, in addition to `repo`. That restriction exists so a leaked token cannot silently alter CI.

Fix it in one place: <https://github.com/settings/tokens> → edit the token → tick **`workflow`** next to `repo`. Then re-run the push unchanged. Note that the refusal applies even if the workflow file is removed from the *latest* commit, because a push sends history and the file exists in earlier commits.

## Working offline, or behind a blocked DNS

If `git` or `npm` cannot reach GitHub while `ping`/TLS to GitHub's addresses works, the cause is name resolution, not the network. Check for entries in the hosts file:

```sh
findstr github C:\Windows\System32\drivers\etc\hosts
```

`tools/gh-tunnel.mjs` in this repository is a local CONNECT proxy that resolves GitHub hostnames with public DNS servers instead of the system resolver, without editing the hosts file and without administrator rights. It binds to `127.0.0.1` only, refuses hosts outside an allow-list, and never decrypts TLS.

```sh
node tools/gh-tunnel.mjs
git config --global http.https://github.com.proxy http://127.0.0.1:18081
git config --global http.sslBackend openssl
```

The `sslBackend openssl` line matters on Windows builds of git that default to `schannel`; without it, connections through a proxy fail with `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`.

To undo both settings:

```sh
git config --global --unset http.https://github.com.proxy
git config --global --unset http.sslBackend
```

DSH itself reads `HTTPS_PROXY`/`HTTP_PROXY` from the environment or from `$DSH_HOME/.env`; it does not read the operating system's proxy settings, and it does not support `socks5://`. See the official [network proxy guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/network-proxy.md).

## Reporting a problem

Include the output of `node tools/doctor.mjs`, the exact error text, and which endpoint answered (the trailing line of the tool result names it). Without those three, a failure caused by a renamed config row is indistinguishable from one caused by a broken endpoint.
