# In one sentence: a way to make DSH cost less

**The short version:** every time the AI answers, it **re-reads the entire conversation from the beginning**. So the longer a conversation gets, the more expensive every single message becomes. This project is about **keeping useless text out of that conversation**.

No technical background needed. Technical version: [`intro-professional.en.md`](intro-professional.en.md) ｜ 中文: [`intro-beginner.zh.md`](intro-beginner.zh.md)

---

## Picture it

Imagine the AI as a **brilliant assistant with a terrible memory**.

You ask a question, and it re-reads **everything** you have said so far before answering. You say one more sentence, and it re-reads everything again. The longer you talk, the more it has to re-read each turn.

```
Message 1: reads 1 page      💰
Message 2: reads 2 pages     💰💰
Message 3: reads 4 pages     💰💰💰💰
... and it keeps multiplying
```

So the real cost is **not** "how much new material did the AI read". It is **"how many times was the old material read again"**.

**Measured, not estimated:** in one session the assistant answered **672 times** and read **287 million tokens** in total. In a typical single request it re-read **250,000 tokens** — and almost all of that was old conversation.

### One counter-intuitive fact

DSH has a caching feature: text it has already read costs about 50 times less the second time.

**But cheaper is not free.** We measured it: **99.3%** of the text was served from cache, and **half the bill (50%) was still spent on re-reading cached text**.

> So caching does not save you money. **Keeping content out of the conversation does.**

## What this project does (four moves)

### Move 1: for long output, keep only the beginning and the end ⭐ most valuable

Say you ask the assistant to list every file in a folder, and it produces **60,000 characters**.

**Before:** all 60,000 characters go into the conversation. Every future answer re-reads all of them.

**Now:** the conversation keeps "the first few lines + the last few lines + a note saying where the full text is stored", about **11,000 characters**. If the details matter, the assistant goes and opens the file.

**Measured:**

| Threshold | How much it catches |
|---|---|
| Factory setting (50,000 chars) | **1** result out of 1,918 — effectively switched off |
| This project (12,000 chars) | **39 results — 33% of all tool output** |

**This is the single most valuable part of the whole thing**, and it is just a configuration number, not a plugin feature.

### Move 2: hand big blocks of text to a free assistant, bring back only the conclusion

When you need the gist of a long document, do not put the document into the conversation. **Give it to a free model** to process, and put only the **conclusion** back.

**Measured:** a 2,689-character input came back as a **74-character** conclusion. And from then on, only those 74 characters get re-read.

### Move 3: when a free service is busy, switch to another one automatically

Free models have a per-minute usage limit. When you hit it, you get an error (429).

**What we found:** **the limit is counted per model, not per account.** We ran one model up to its limit (429 after burning 224,713 tokens in 22 seconds), and then three other free models **answered immediately**.

So when one is busy, you switch to another and get around it in **about one second**, instead of waiting a minute. Six free models together give roughly **300,000 TPM** of capacity.

### Move 4: find out where the money actually goes

A few small scripts read your own session logs and work out the real bill. **Because guessing gets the direction wrong.**

## The most important thing costs nothing

**Make fewer, better-aimed requests.**

Measured requests per turn:

| Session | You said | The assistant made | Per message |
|---|---|---|---|
| One session | 50 messages | 672 requests | 13.4 |
| Another | **1 message** | **84 requests** | **84** |

Same tooling. One person's message triggered 13 requests; another's triggered 84. **Every redundant call re-reads the whole history.**

So: think before calling a tool, do not re-read the same file, and ask for what you need in one go rather than five. This costs nothing and has the biggest effect.

## How to use it (three steps)

```sh
# 1. install into a DSH profile
dsh plugin --profile web add <path to this project>

# 2. copy one configuration template
#    templates/profile-patch.hosted.yml      free online model + local fallback
#    templates/profile-patch.local-only.yml  local model only

# 3. restart DSH, then check
node tools/doctor.mjs
```

**Step 2 is not optional.** Installing the plugin alone will barely change your bill. The configuration number that blocks large output is what does the work.

## What it is not (to avoid misunderstandings)

- It does **not** change your model, and it does not lower answer quality.
- It is **not** a free replacement. The paid model is still the main one; this just makes it spend less.
- It does **not** need a graphics card (if you use the free online model). A local model is optional — it is the fallback for when the free allowance runs out.

## The honest downsides

- If you use a local model, it is **slow**: roughly a second or more per 1,000 characters.
- Free allowances are finite. Heavy use will hit them.
- "Keep the beginning and the end" means the AI cannot see all of that output at a glance; it has to open the file if it needs the middle (usually it does not).

## How to know it is actually working

```sh
node tools/doctor.mjs
```

It reports whether your configuration is applied, whether the plugin loaded, whether the API key resolves, and whether any file encoding is damaged. It fails loudly rather than silently.

## One honest story

The first version had a bug: **the configuration looked completely correct, but every call to the free model failed** with "invalid token".

The cause was subtle. DSH stores your key in a file but does **not** turn it into an environment variable, and the plugin only looked at environment variables — so it read nothing and sent a fake key.

**That is fixed** (the plugin now reads the file directly), and the self-check specifically tests for it. It is written down here because the value of this project is not only in what it figured out, but in **turning the mistakes into checks that catch themselves**.
