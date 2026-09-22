# dsh-token-saver

**把庞大的文本挡在对话记录之外，从而压低 DSH 会话的 token 账单。**

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，外加经过实测的配置和配套的测量工具。无需构建，不引用 harness 内部模块，只依赖两个公开包。

> ### 不懂命令行？让 AI 帮你装
>
> 把 **[docs/install-with-ai.zh.md](docs/install-with-ai.zh.md)** 整个复制给你的 AI 助手，
> 它会照着装、并且**逐条验证**装成功了没有。那份文件是专门为「小白 + AI 代装」写的。
>
> **第一次来？** 先看[小白版介绍](docs/intro-beginner.zh.md)或[技术版介绍](docs/intro-professional.zh.md)。
> 其余文档（架构、实测数据、兼容性、排障）索引在 [`docs/`](docs/README.md)。
>
> English: [README.md](README.md) ｜ [plain language](docs/intro-beginner.en.md) / [technical](docs/intro-professional.en.md)

---

## 问题不是「模型贵」

agent 循环不是「一个会话发一次请求」，而是**每一步发一次请求**，而且每次请求都会重发到目前为止的整份对话记录。以下数字来自本项目自己的会话日志：

| 指标 | 数值 | 命令 |
|---|---|---|
| 单个会话的请求数 | **672** | `test/turns-report.mjs` |
| 该会话的提示 token 总量 | **287,481,671** | `test/cost-report.mjs` |
| 每次请求的提示大小（中位数） | **252,044 token** | `test/cost-report.mjs` |
| 全部会话的缓存命中率 | **99.3%** | `test/cost-report.mjs` |

第三行值得再看一遍：**中位数请求要重发 25 万个 token**，而其中绝大部分是历史。

**缓存救不了你。** 99.3% 的提示 token 命中缓存，而实测账单里仍然有 **50.0% 是「缓存输入」**——因为命中缓存的输入**照样计费**。高命中率只说明前缀稳定，不代表重发免费。

所以杠杆不是「换个更便宜的模型」，而是**减少被重发的内容**：

```
成本  ≈  （平均上下文大小） × （请求数）
```

两个因子你都能控制，本项目对两者都下手。

## 它到底做了什么，效果多少

| 机制 | 实测效果 | 在哪一层 |
|---|---|---|
| **工具输出 spill** | 出厂的 50KB 阈值在 **1,918** 个结果里只命中 **1 个**（占工具文本 2.0%）。降到 **12KB 捕获 39 个结果、占 33.0%**。一条实测 60,562 字节的输出，只有约 11,600 字节进入对话记录。 | 配置 |
| **把大块文本委派给免费模型** | 一次实测委派把 14,366 字符的负载变成 **122 字符**的答案——此后被反复重发的只是这 122 字符。 | 本插件 |
| **免费模型限流时自动轮换** | 免费额度按**模型**独立、不按账号（已实测）。被限流的模型约 1 秒即可绕开，而不是等一分钟。 | 本插件 |
| **从日志量出真实账单** | 四个脚本报告 token 究竟花在哪，让下一个决定有证据。 | 本仓库 |

还有一个数字，因为它是**最便宜的收益**：实测「每轮用户消息触发的请求数」**在 1.0 到 84.0 之间**。本机有一个会话**单个用户轮次就发了 84 次请求**。少调、调准，零成本。

## 诚实的账

- **最大的一项节省是配置值，不是这个插件。** 把 `maxInlineBytes` 从出厂 50,000 降到 12,000，价值超过插件做的所有事。只做一件事的话，就做这个。
- **把会话标题移到免费通道是小收益**，已配置但不夸大。账单大头是重发，不是标题。
- **压缩器刻意留在付费通道。** 它的摘要器会逐字重放对话前缀，交给本地模型会很慢；而且含图片的会话会直接失败，因为本地模型声明只接受文本输入。
- **缓存命中占账单 50%，本项目并不降低这个比例**，它降低的是「被缓存的总量」。这个区别决定你该在哪里投入。
- **这里的数字来自一台机器的日志。** 脚本都附上了，你可以先量自己的，再决定信不信。见 [docs/measurements.md](docs/measurements.md)。

## 快速开始

需要 DSH `0.1.5-rc.2` 或更高（见 [版本兼容性](#版本兼容性)），以及 Node 22.19+。

```sh
# 1. 把插件装进某个 profile（profile 清单由 pnpm 自己写）
dsh plugin --profile web add ./dsh-token-saver

# 2. 应用真正起作用的那部分配置
#    把其中一个模板覆盖到 $DSH_HOME/profiles/web/cordis.patch.yml
#      templates/profile-patch.hosted.yml      免费托管为主 + 本地兜底
#      templates/profile-patch.local-only.yml  只用本地 llama.cpp

# 3. 确认组合结果，然后重启 DSH
dsh --profile web --dump-config

# 4. 自检，确认这些改动是否仍然生效
node tools/doctor.mjs
```

**第 2 步不是可选的。** 只装插件几乎不会改变你的账单——真正起作用的是 spill 阈值和免费模型路由。

> 要**把这个项目发布到 GitHub**（还没有账号、或被网络卡住）的人，请直接看 [`docs/publishing.zh.md`](docs/publishing.zh.md)：从注册、拿 token、建仓库到推送的错误对照表，都写好了。

插件在 **DSH 服务端重启**后才加载，刷新页面不算：profile 的 bundle 列表只在组合时读取一次。

### 之后改源码：`link:` 与 `file:` 的区别

`dsh plugin add <路径>` 装出来的是 **`link:`** 依赖，也就是指向你检出目录的目录联结（Windows）或符号链接。我把本插件装进一个一次性 profile 实测，结果是：

```
dependencies: { "dsh-plugin-local-offload": "link:C:/…/dsh-token-saver" }
node_modules/dsh-plugin-local-offload → Junction → C:\…\dsh-token-saver
```

所以在**官方安装命令**下，改这个检出只需**重启 DSH**，不必重装。`tools/doctor.mjs` 会比对这两条路径并报告 `installed copy is byte-identical to this source checkout`。

而 **`file:`** 依赖是**拷贝**——那是早先手写安装脚本的产物，用它的话每次改源码都要「重装 + 重启」。如果 `doctor.mjs` 报告安装副本与源码不一致，先确认你的 profile 用的是哪种写法：

```sh
grep dsh-plugin-local-offload "$DSH_HOME/profiles/web/package.json"
```

把 `file:` 换成 `link:`：

```sh
dsh plugin --profile web remove dsh-plugin-local-offload
dsh plugin --profile web add /path/to/dsh-token-saver
```

`dsh plugin add <路径>` 只要有这份检出就能用，不需要任何 registry；而且 profile 清单由它自己写，也就不可能手动引入 BOM。

### 配置项

工具由 profile 的 `cordis.patch.yml` 配置，不必改插件。完整字段与理由见 [`templates/README.md`](templates/README.md)。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:18080` | OpenAI 兼容端点的源，末尾不带 `/v1` |
| `model` | `local-qwen3-8b` | 发给端点的模型 id |
| `apiKey` / `apiKeyEnv` | `local-no-key` / 未设 | 直接的 bearer token，或存放它的环境变量名。优先用 `apiKeyEnv`，避免密钥写进配置 |
| `chain` | `''` | 有序轮换链，JSON 数组，元素形如 `"baseUrl|model"` |
| `chainApiKeyEnv` | 跟随 `apiKeyEnv` | 链上其他主机所用的独立凭据 |
| `cooldownSeconds` | `65` | 被限流端点停放多久。额度按分钟计 |
| `maxContextTokens` | `0` | 端点无法自报上下文窗口时采用的假定值 |
| `maxInputChars` | `400000` | 单次负载的字符上限，超出则截断并告警 |
| `maxOutputTokens` | `1024` | 单次调用的默认输出上限 |
| `timeoutMs` | `300000` | 单次调用超时 |
| `temperature` | `0.2` | 偏低，使提取更忠实 |
| `extraBody` | `''` | 合并进每个请求体的 JSON 对象，作为逃生口 |
| `credentialsFile` | `<DSH_HOME>/.credentials.yaml` | 环境变量没取到时，去哪里读已保存的凭据。设为空字符串即禁用该查找 |

`maxInputChars` 只是粗粒度护栏；真正的上限来自端点的**真实 token 窗口**（取其 75% 再减去输出预算），并且**单次调用封顶 7,000 token**——一次委派不该吃掉一整分钟的额度。

### 密钥到底从哪里来

在 DSH 的 Models 页面保存一次，或直接写进 `<DSH_HOME>/.credentials.yaml` 的 `refs:` 下：

```yaml
refs:
  SILICONFLOW_API_KEY: sk-...
```

然后在配置里用 `apiKeyEnv: SILICONFLOW_API_KEY` 指明这个名字。

**不要指望 `process.env` 里会有它。** harness 只为**它自己的路由**按需解析 `apiKeyEnv` 引用，**不会**把这些值导出到进程环境。实测结论：整个已安装的 harness 里，只有 `dsh-app-boot`（它物化的是 `.env` **文件**，属于另一个存储）与 `dsh-http-proxy` 会写 `process.env`。本插件最初的版本正是读 `process.env[apiKeyEnv]`，结果把占位符当 token 发出去，**每一次委派都拿到 HTTP 401**——所以现在插件改为**自己按请求解析**：先环境变量、再 `credentialsFile`、最后才退回字面占位符。

如果你确实以真实环境变量注入密钥，它依然优先；此时把 `credentialsFile` 设为 `''` 可以彻底禁止文件查找——在容器里这是正确的选择。

### 工具用法

`local_delegate(task, instruction, text, maxTokens?)`

| `task` | 用途 |
|---|---|
| `summarize` | 对长文档/日志做密集的事实摘要 |
| `extract` | 从大块文本中抽取指定字段、标识符、结论 |
| `classify` | 按指令给出标签 |
| `translate` | 翻译，同时保留代码与标识符 |
| `rewrite` | 重组结构而不丢事实 |
| `answer` | 仅以负载为证据回答问题 |
| `code` | 分析代码，精确到文件、符号、行级问题 |

每个结果末尾都会标明是哪个模型、消耗多少 token，节省是**看得见的**而不是假设的。发生轮换时会多一行说明链路状态。

## 版本兼容性

| Harness 版本 | 状态 |
|---|---|
| `0.1.5-rc.2` | **已实测**——就在这个版本上开发和测量 |
| `master`（当前检出） | **接口已核对**——插件 API 与全部 4 个配置行 id 均对照官方仓库核实 |
| 更高版本 | **未测试**——不是「已知损坏」，只是「未验证」 |
| `0.1.2-alpha.*`、`0.1.3-alpha.*`、`0.1.5-alpha.*` | **不支持**——`0.1.2-alpha` 是架构重构并附有插件兼容性提醒 |

升级后请跑 `node tools/doctor.mjs`。它零依赖，会报告：4 个配置行 id 是否还在、`defineTool` 签名是否仍匹配、插件依赖面是否仍然干净、`~/.dsh` 是否有 BOM 损坏。出问题时退出码非零。

**失效被设计成「安静且可恢复」**：配置行若被改名，该条 patch 变成空操作，DSH 退回出厂行为，**不会崩**。插件自身若 API 变化则会**响亮地失败**（根本加载不了）。

[docs/compatibility.md](docs/compatibility.md) 写了升级后该查什么、每种失效怎么修，并且**刻意写了「如何从零重建这四个机制」**——那一节是照着「比本仓库活得更久」来写的。

## 本仓库不做什么

- 它**不**降低每 token 单价，也**不**换你的模型。
- 它**不**实现 spill。spill 在 harness 内部发生，插件影响不了；本仓库做的是测量并配置它。
- 托管配置**不**需要 GPU。本地 `llama.cpp` 服务是可选的，它是轮换链的兜底，不是前置条件。
- 它**不**把付费模型变成免费模型。付费模型仍是主力，目标只是让它少花 token。

## 仓库结构

| 路径 | 作用 |
|---|---|
| `lib/index.js` | 插件入口：`Config` schema 与 `apply` |
| `lib/tools.js` | `local_delegate` 工具：任务契约、负载钳制、跨链尝试 |
| `lib/rotation.js` | `EndpointChain`：按端点冷却、自动恢复。**不引用任何 harness 模块** |
| `lib/http.js` | OpenAI 兼容客户端、思维链剥离、URL 归一化、本地服务自愈 |
| `lib/embeddings.js`、`lib/indexer.js`、`lib/vector-store.js` | 语义检索原型：已测量并搁置（没有会被反复查询的本地语料） |
| `tools/doctor.mjs` | 升级后自检。零依赖 |
| `tools/gh-tunnel.mjs` | DNS 被拦时的 GitHub 本地 CONNECT 隧道。见[排障](docs/troubleshooting.md#working-offline-or-behind-a-blocked-dns) |
| `templates/` | profile patch 模板，每个值旁边写着它的理由 |
| `test/` | 测量与验证脚本 |
| `.github/workflows/ci.yml` | 回归网：语法、凭据规则、轮换、编码、自检 |
| `docs/` | [架构](docs/architecture.md)、[实测数据](docs/measurements.md)、[兼容性](docs/compatibility.md)、[排障](docs/troubleshooting.md)、[打赏](docs/sponsor.md) |
| `docs/publishing.zh.md` | **从零发布到 GitHub 的逐步指引**，含本机实测的网络结论与 token 安全边界 |

## 值得知道的设计约束

- **只 import 两个公开包**：`@deepseek-ai/dsh-tools`（`defineTool`）与 `@deepseek-ai/schemastery`。不引用任何 harness 内部模块。`node tools/doctor.mjs` 会对着实际安装的源码**重新核对这一点**，而不是让你相信这句话。
- **工具定义与官方教程逐字段一致**，因此它没有依赖任何未公开的接缝。
- **无构建步骤。** 纯 ESM JavaScript。这对分发很重要：从 git 主机安装的 TypeScript 包拿到的是源码而非构建产物，会因缺少 `lib/` 而加载失败；而且 pnpm ≥ 10 还要用户显式白名单才肯运行 git 依赖的 `prepare` 脚本——那等于授权「在安装时执行该包代码」。预构建或 tarball 分发能绕开全部问题，而本包连构建都不需要。
- **没有硬编码的可调参数。** 每个随部署而变的选项都是可从 `cordis.patch.yml` 修改的、经过校验的 `Config` 字段——这正是 harness 自己的 `AGENTS.md` 对插件的要求。

## 测试

**本仓库没有任何第三方依赖**——插件没有，测试也没有。下面每个脚本都能在「什么都没装」的环境里直接跑。

```sh
node tools/doctor.mjs                 # 自检；任何目录都能跑
node tools/doctor.mjs --strict        # 警告也算失败；CI 跑的就是这个
node tools/verify-live.mjs            # 端到端验收（见下）
node test/test-credentials.mjs        # 凭据解析顺序与各种边界情况
node test/test-rotation.mjs           # 轮换单测：停放、跳过、自动恢复、多点位停放
node test/test-yaml-min.mjs           # 自研 YAML 读取器；能拿到 js-yaml 时逐值对拍
node test/tunnel-resilience.mjs       # GitHub 隧道能扛住连接重置风暴
node test/check-bom.mjs               # 扫描 $DSH_HOME 的 BOM / JSON 损坏
node test/cost-report.mjs             # 从你自己的会话日志算出账单构成
node test/profile-report.mjs          # 工具输出体积与每次请求的提示大小
node test/turns-report.mjs            # 每轮用户消息触发的请求数
node test/cache-report.mjs            # 按会话统计缓存与压缩次数
node tools/check-links.mjs            # 校验所有文档相对链接都能解析
```

### 需要「按包名 import 插件」的脚本，先跑一次设置

有少数脚本**刻意按包名**（`dsh-plugin-local-offload`）import 插件，为的是走**和 DSH 完全相同的解析路径**，而不是绕过它直接指向 `lib/`。这些脚本、以及用 `@deepseek-ai/dsh-llm-pi-ai` 的那两个，需要一个 `node_modules` 条目。一条命令就能建好，指向你机器上**已有的 harness**——不用安装、不需要管理员权限：

```sh
node tools/setup-dev.mjs           # 建立链接
node tools/setup-dev.mjs --status  # 只看状态，不做改动
```

它会把 `node_modules/@deepseek-ai` 指向 harness 自己的副本，并把 `node_modules/dsh-plugin-local-offload` 指向本检出。`node_modules/` 已在 `.gitignore` 中，不会进仓库。如果在 Windows 上建链接被拒，脚本会直接打印两条等效的 `mklink /J` 命令——那个不需要特权。

没做这一步也能跑的，是那些**不 import 插件、也不 import harness 包**的脚本：`doctor.mjs`、`check-links.mjs`、`setup-dev.mjs`、`test-yaml-min.mjs`、`check-bom.mjs`、`tunnel-resilience.mjs`、`test-rotation.mjs`，以及四个报表脚本（`cost-report`、`profile-report`、`turns-report`、`cache-report`）。

需要这一步的有 11 个：`verify-live.mjs`、`verify-all.mjs`、`verify-route.mjs`、`test-credentials.mjs`、`test-plugin.mjs`、`test-defer.mjs`、`test-race.mjs`、`test-selfheal.mjs`、`test-payload-guard.mjs`、`test-rotation-live.mjs`、`test-siliconflow.mjs`。它们**在 import 失败时会直接打印 `node tools/setup-dev.mjs`**——所以全新克隆不会只丢一个看不懂的 `ERR_MODULE_NOT_FOUND` 给你。

### 为什么有两个验证脚本

`test/verify-all.mjs` 检查得更全：它用 harness 自己的 `Config` schema 校验路由，还逐字节比对安装副本与源码。但它**按裸包名 import** harness 包，而 ESM 对裸包名的解析**只相对于「导入它的那个文件」所在目录，与当前工作目录无关**。因此放在 DSH 安装目录之外 `node_modules` 树里的脚本根本解析不到；连从 profile 目录动态 `import()` 都会失败，因为被导入文件内部的包名仍然按那个文件解析：

```
$ cd ~/.dsh/profiles/web
$ node <repo>/test/verify-all.mjs
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-llm-pi-ai'
```

`node tools/setup-dev.mjs` 就是为此而存在的。`tools/verify-live.mjs` 则是「完全不需要任何设置」的那条路，保证在全新克隆上也总有办法验证插件。

### 会「跳过」而不是「失败」的测试

`test/test-client.mjs` 与 `test/verify-route.mjs` 需要本地 `llama.cpp` 服务，而它**刻意不再自动启动**（它跑起来就要占显存，而它只是兜底）。没有服务在监听时，它们打印 `SKIP` 并以退出码 0 结束——因为「端点不存在」和「端点坏了」是两件不同的事，不该长得一样。需要时用 `powershell -File F:\bonsai\start-local-ai.ps1` 拉起，它们就会真正跑起来。

`.github/workflows/ci.yml` 在 Node 22.19 与 24、Linux 与 Windows 上跑那批离线检查，并且把 `DSH_HOME` 指向一个**空目录**——这样开发机真实的 harness home 永远影响不到结果，也不会有任何检查读到真实凭据。这里用代码格式写出路径而不是做成链接，原因见下方说明：该文件**可能合理地不存在于已发布的副本里**，而指向缺失文件的链接比一个纯路径名更糟。

CI **刻意不安装 harness**。harness 是一个仍在变动的 pre-stable 目标，把它钉进 CI 只会产出与本仓库无关的失败；那一类问题该由 `tools/doctor.mjs` 对着真实安装来回答。CI 也不跑 `verify-live.mjs`——那意味着要往 CI secrets 里放 API key，而本项目的前提恰恰是免费额度加本地模型就够用。

`tools/verify-live.mjs` 是端到端验收。它验证的是**本仓库源码**（不是 profile 里那份安装副本），并尤其断言一条行为性质：一次 `extract` 委派必须返回合成负载中**全部四个**不同的错误码。曾经因为指令模糊，8B 模型只返回了 4 个里的 2 个就停了，所以系统提示里那段「穷尽性」要求是承重的，这个测试负责让它一直承重。

```sh
node tools/verify-live.mjs            # 联机，打到配置好的端点
node tools/verify-live.mjs --offline  # 只做注册与契约检查，不联网
```

## 参与贡献

最有价值的贡献是**一条与本文数字矛盾的实测**，并附上产生它的命令。其次是你的 harness 版本和 `doctor.mjs` 输出——那才是让兼容性表格保持诚实的数据。

## 许可证

[MIT](LICENSE)。

## 打赏

自愿、非商业。如果这套东西帮你省了钱，[收款入口在这里](docs/sponsor.md)——不换取任何商品、服务、支持或优先级，也从不主动索取。
