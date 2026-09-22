# dsh-token-saver 是什么

**给 DSH（DeepSeek Harness）用户的一套「少花 token」方案。** 它不换模型、不降质量，而是减少**被反复重发的内容**。

本文面向**技术人员**。想看通俗版：[`intro-beginner.zh.md`](intro-beginner.zh.md) ｜ English: [`intro-professional.en.md`](intro-professional.en.md)

---

## 1. 要解决的痛点

付费 agent 循环的计费方式不是「一个会话一次请求」，而是**每一步一次请求，且每次重发整份对话历史**。

本方案在真实会话日志上实测（`node test/cost-report.mjs`）：

| 指标 | 实测值 |
|---|---|
| 单个会话请求数 | **672 次** |
| 该会话提示 token 累计 | **287,481,671** |
| 每次请求提示大小（中位数） | **252,044 token** |
| 全部会话缓存命中率 | **99.3%** |

**关键结论：缓存救不了成本。** 99.3% 的提示 token 命中缓存，而账单里仍有 **50.0% 是「缓存输入」**——命中缓存照样计费。所以：

> 账单大头不是「读了多少新东西」，而是「历史被重发了多少次」。

这一点不纠正，后面的优化方向全都会走错。

## 2. 解决思路

成本近似等于：

```
成本 ≈ （平均上下文大小） × （请求数）
```

两个因子都可控，方案对两者都下手：

| 机制 | 做法 | 实测效果 |
|---|---|---|
| **工具输出 spill** | 超过阈值的大块工具结果，**在进入上下文之前**换成「头尾预览 + 落盘定位符」，全文留在磁盘上可 `read`/`grep` 取回 | 出厂阈值 50 KB 在 1,918 条结果里只命中 **1 条（占工具文本 2.0%）**；降到 **12 KB 命中 39 条、占 33.0%** |
| **免费模型委派** | 大块文本交给免费模型加工，只把摘要留在上下文 | 2,689 字符进 → 74 字符出；一次 14,366 字符的负载 → 122 字符答案 |
| **限流自动轮换** | 免费端点限流时换下一个模型，全不可用才落本地 | 实测额度**按模型独立**：打满一个（224,713 token 后 429）后，另外三个免费模型立刻返回 200 |
| **成本测量** | 从会话日志反推真实账单构成 | 缓存输入 50.0% / 未缓存输入 18.1% / 输出 31.8% |

### 为什么「先控制」比「后压缩」好

直觉做法是「上下文满了再压缩」。但压缩会：① 等窗口快满才生效，大块文本已经重发了很久；② 花一次摘要调用；③ **重写历史，从改写点起打断缓存**。

spill 发生在**插入时**，是 append-only 操作，不破坏可复用前缀，也不额外调用模型。

### 第一杠杆其实是「每轮请求数」

实测每轮用户消息触发的请求数（`node test/turns-report.mjs`）：

| 会话 | 用户轮数 | 请求数 | 每轮请求 | 平均上下文 |
|---|---|---|---|---|
| session-5c6c5f60 | 50 | 672 | 13.4 | 427,800 |
| session-42f1524a | 18 | 571 | 31.7 | 339,276 |
| session-bb7d2e5c | 1 | 84 | **84.0** | 92,699 |

同一个工具，有人每轮调 13 次，有人一个轮次调 84 次。**每一次多余的工具调用都要重发一遍全部历史**，而这是使用者当场就能控制的。

## 3. 实现方式

### 3.1 依赖面（抗升级的关键）

插件**只 import 两个公开包**：

```js
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
```

**不引用任何 harness 内部模块**。工具定义与官方教程 [`docs/user/develop/basic/tool.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/tool.md) **逐字段一致**（`name` / `description` / `parameters` / `output.schema` / `output.render` / `execute`，经 `ctx.tools.register` 注册）。

配置层按 id patch 4 个已存在的行：

| 行 id | 归属 | 改了什么 | 若被改名 |
|---|---|---|---|
| `spill-policy` | `@deepseek-ai/dsh-base` | `maxInlineBytes: 50000 → 12000` | patch 失效，退回出厂行为 |
| `session-title-llm` | `@deepseek-ai/dsh-base` | 标题生成改走免费通道 | 同上 |
| `session-query-sqlite` | `@deepseek-ai/dsh-base` | 出厂是 `:memory:` + `openAt: never`，改为落盘 + `first-search` | 同上 |
| `local-offload` | 本插件自己的 `cordis.yml` | 插件自己的行 | 插件根本不加载 |

**失效模式是「静默降级」而不是崩溃**：前三个被改名 → patch 空转，DSH 退回出厂行为；插件自身 API 变化 → 响亮报错（加载不了）。`tools/doctor.mjs` 专门检查这两类。

### 3.2 插件做的事

注册一个工具 `local_delegate(task, instruction, text, maxTokens?)`，7 种任务契约：`summarize` / `extract` / `classify` / `translate` / `rewrite` / `answer` / `code`。

三处设计是被实测逼出来的，不是风格选择：

**① 负载上限按端点的 token 窗口算，不按字符数。** 中文约 1 token/字符，英文约 1 token/4 字符——没有单一字符上限能同时约束两者。一个 30,000 字符的中文负载曾直接把 llama-server 打死，症状只是 `fetch failed`。现在按 `n_ctx × 0.75 − 输出预算` 钳制，并且单次调用封顶 7,000 token（实测一次 50,000 TPM 额度只够 **19 次贵请求**，一次调用不该吃掉一整分钟的额度）。

**② 系统提示里的「穷尽性」要求是承重的。** 同样负载、同样任务，指令模糊时 8B 模型只返回 4 个错误码里的 **2 个**就停了；明确要求穷尽后，连续 3 次都返回全部 4 个。`test/verify-live.mjs` 为此专门断言。

**③ 轮换只对「可重试」错误生效。** 429 和网络不可达才推进链路；401（凭据被拒）立即报错——同一个坏 key 在每个端点都会失败，重试五个端点只是浪费。

### 3.3 一个必须知道的 harness 细节

**harness 不会把 `.credentials.yaml` 导出到 `process.env`。** 我们实测确认：整个已安装的 harness 里，只有 `dsh-app-boot`（物化 `.env` **文件**）和 `dsh-http-proxy` 会写 `process.env`。

所以插件如果只读 `process.env[apiKeyEnv]`，**拿到的是 undefined**，然后发出占位符 → **每次委派 HTTP 401**。本项目的第一版正是如此（配置看起来完全正确，实际从未成功过）。

现在的解析顺序是：**环境变量 → `credentialsFile` → 字面值（并告警）**，且**按请求实时解析**，所以启动后新保存的密钥无需重启即可生效。

> 如果你要移植到别的 harness，**这一条是第一个要验证的**。

### 3.4 隐私与数据流

- spill 的全文**留在本机磁盘**（`$TEMP` 下的 spill 目录），不额外外发；
- 委派只把你**主动传入**的 `text` 发给配置的端点。用本地 llama.cpp 时不出机器；用托管免费端点时，那段文本会离开本机——**这一点必须按你的数据敏感度自行判断**；
- 插件会把请求体里的 `enable_thinking` 设为 `false`，并在返回后剥离 `<think>` 块，因为思考 token 既无用又计费。

## 4. 版本兼容性（诚实标注）

| Harness 版本 | 状态 |
|---|---|
| `0.1.5-rc.2` | **已实测**（开发与测量都在此版本） |
| `master`（撰写时官方仓库） | **接口已核对**：4 个行 id 存在、`defineTool` 签名一致 |
| 更高版本 | **未测试**（不是「已知损坏」，是「未验证」） |
| `0.1.2-alpha.*` / `0.1.3-alpha.*` / `0.1.5-alpha.*` | **不支持** |

升级后跑 `node tools/doctor.mjs`（零依赖，出问题退出码非零，并会打印自己的检查清单，让你知道覆盖了哪些面）。它检查：harness 版本、`defineTool` 接口面、4 个配置行 id、委派凭据能否真正取到、安装副本是否与包实际发布的文件一致、import 依赖面、以及**两个方向相反的编码规则**。修复路径与「如果彻底失效，如何从零重建这四个机制」写在 [`compatibility.md`](compatibility.md)。

## 5. 它不做什么

- **不降低每 token 单价**，不换你的主模型；
- **不实现 spill**——spill 在 harness 内部发生，插件影响不了，本项目做的是**测量并配置**它；
- **不把付费模型变免费**。付费模型仍是主力，目标只是让它少花 token；
- **不需要 GPU**（托管配置下）。本地 llama.cpp 是轮换链的兜底，不是前置条件。

## 6. 已知代价

- 本地模型预填**在低显存设备上**很慢：本机（**Radeon RX 5700，仅 8GB 显存**）实测 **约每 1,000 字符 1 秒**
  （4K token ≈ 33 s，8K ≈ 113 s，14K ≈ 300 s），据此建议单次 ≤ 6,000 字符。
  **这是硬件属性而非 llama.cpp 的属性**：模型加 KV 缓存要挤进 8GB，属于最差情形之一。
  显存更大的机器会明显更快 —— 换机器请用 `test/bench.mjs` 重测，不要套用本机数字。
- 免费额度有上限。实测单模型 50,000 TPM，6 个免费对话模型合计约 300,000 TPM。
- spill 的预览是模型对那段输出的**唯一即时视图**；阈值设太低会强迫一次检索往返。实测不宜低于 ~12 KB（`compaction-tool-result-pruner` 在 8,192 字符已经会动手）。

## 7. 快速验证

```sh
node tools/doctor.mjs        # 环境自检：配置行、API 签名、依赖面、编码
node tools/verify-live.mjs   # 端到端：注册 + 契约 + 真实委派 + 穷尽性回归
```

完整的实测数据与复现命令见 [`measurements.md`](measurements.md)。
