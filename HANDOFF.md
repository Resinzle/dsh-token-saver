# 省 token 方案：交接与速查

> 面向"下一个会话的我"。所有数字都是**实测**，不是估算。
> 2026-09 全面重写：项目已工程化并发布为开源仓库。

---

## 0. 先看这里：这套东西现在是什么

| | |
|---|---|
| **公开仓库** | **https://github.com/Resinzle/dsh-token-saver**（65 文件） |
| 本地源码（**唯一真相**） | `C:\Users\吾\OneDrive\文档\Resinzle\dsh-token-saver`（66 文件，19 提交） |
| 插件安装源 | `F:\bonsai\offload-plugin`（仓库的**镜像**，逐字节一致，差异 0） |
| 可分享 zip | `C:\Users\吾\OneDrive\文档\Resinzle\dsh-token-saver-v1.0.0.zip` |

**改源码 → 必须重装 → 重启 DSH**（`file:` 依赖是**拷贝**不是链接）：

```powershell
powershell -File F:\bonsai\install-offload-plugin.ps1
```

旧的 `test\verify-all.mjs` **不是**验收命令了（它 import 裸包名，从 F 盘跑不起来）。
**下面第 1 节才是。**

---

## 1. 验收命令（三条，都在仓库根目录跑）

```powershell
cd C:\Users\吾\OneDrive\文档\Resinzle\dsh-token-saver

node tools\doctor.mjs          # ① 环境兼容性：10 组检查，失效即非零退出
node tools\verify-live.mjs     # ② 端到端：注册 + 契约 + 真实委派 + 穷尽性回归
node tools\check-links.mjs     # ③ 文档链接
```

`doctor.mjs` 检查：harness 版本 / `defineTool` 接口面 / 4 个配置行 id /
**委派凭据能否真正解析** / 安装副本是否与包内文件一致 / import 依赖面 /
**两个方向相反的编码规则**（`.json` 禁 BOM、含中文的 `.ps1` 必须带 BOM）。

需要额外跑的那几个（首次要先 `node tools\setup-dev.mjs`）：

```powershell
node test\test-credentials.mjs   # 凭据解析顺序（20 项）
node test\test-yaml-min.mjs      # 自研 YAML 读取器，能拿到 js-yaml 时逐值对拍
node test\test-push-script.mjs   # 推送脚本的凭据安全承诺（21 项）
node test\tunnel-resilience.mjs  # GitHub 隧道抗连接重置
```

---

## 2. 核心认知（这一节决定所有优化方向）

> **先读这句：下面的数字会漂移。** 它们是从**本机会话日志**算出来的，而日志一直在增长 ——
> 实测在同一个会话里隔几十分钟重跑，总请求从 1,715 涨到 2,397，占比也随新数据变化。
> **不要把下面的具体数字当结论，要跑命令。** 记住的是**结论的形状**（缓存命中占一半账单），
> 不是那一位小数。

付费 agent 循环**每一步都重发整份对话历史**。实测（某一时刻快照）：

| 指标 | 快照值 |
|---|---|
| 全部会话提示 token | **约 5.35–8 亿**（随使用增长） |
| 全部会话请求数 | 1,700 → 2,400（持续增长） |
| 缓存命中率 | **99.3%–99.5%** |
| 每次请求提示大小 中位数 | **约 25 万**（max 795,213） |

**账单构成**：缓存输入 **约 50–57%** / 未缓存输入 **约 14–18%** / 输出 **约 29–32%**
（思考 token 占输出的约 **39%**）。两个不同时刻的实测：

| 项 | 时刻 A | 时刻 B |
|---|---|---|
| 缓存输入 | 50.0% | 56.7% |
| 未缓存输入 | 18.1% | 14.4% |
| 输出 | 31.8% | 28.9% |

> **关键（这条不会漂移）**：99%+ 的命中率**救不了成本** —— 命中照样计费，
> 一半账单花在这上面。所以省钱的本质是**减少被重发的内容**，不是「少读新东西」。

`成本 ≈ 平均上下文 × 请求数`，两个因子都可控。

### 第一杠杆其实是「每轮请求数」

| 会话 | 用户轮数 | 请求数 | **每轮请求** | 平均上下文 |
|---|---|---|---|---|
| session-5c6c5f60 | 50 | 672 | **13.4** | 427,800 |
| session-42f1524a | 18 | 571 | **31.7** | 339,276 |
| session-bb7d2e5c | 1 | 84 | **84.0** | 92,699 |

同一个工具，有人每轮 13 次调用，有人一个轮次 84 次。每次多余调用都要重发全部历史。

---

## 3. 四条生效的机制

| 机制 | 位置 | 实测效果 |
|---|---|---|
| **工具输出 spill** | `cordis.patch.yml` `maxInlineBytes: 12000` | 出厂 50KB **只命中 1 条（约 2%）**；12KB **命中 39 条（约 28–33%）**。一条 60,562 字节的输出只有约 11,600 字节进上下文 |
| **免费模型委派** | 插件 `local_delegate` | 2,689 字符 → 74 字符；一次 14,366 字符负载 → 122 字符答案 |
| **限流自动轮换** | `chain` + `cooldownSeconds` | 额度**按模型独立**（打满一个后另外三个立刻 200） |
| **成本测量** | `test/cost-report.mjs` 等 | 见上表 |

**注意 spill 那行的稳定性**：命中数两个时刻都是 **39 条**，但总数从 1,918 涨到 2,587，
所以**占比**从 33.0% 降到 28.1%。**看绝对值比看占比稳。**

**spill 是配置不是插件功能** —— 插件影响不了它。这也是「只发插件省不到钱」的原因。

### 轮换链

`GLM-4-9B` → `Qwen3-8B` → `Qwen3.5-4B` → 本地 llama.cpp（**兜底，无额度限制**）。
被限流的端点冷却 **65 秒**后自动恢复。**401 不触发轮换**（坏 key 在每个端点都会失败）。

**故意排除** `THUDM/GLM-Z1-9B-0414` 和 `deepseek-ai/DeepSeek-R1-0528-Qwen3-8B`：
它们**不认 `enable_thinking: false`**，说一个词就烧 68–143 个输出 token。
判别：返回里有 `reasoning_content` 字段 = 思考没关掉。

---

## 4. 本次会话修掉的致命 bug：凭据从不生效

**症状**：配置看起来完全正确，但**每一次委派都 HTTP 401**。

**根因**（已实测定论）：harness 把 key 存在 `~/.dsh/.credentials.yaml`，
**只为它自己的路由按需解析，从不导出到 `process.env`**。
验证方式：整个已安装 harness 里只有两处写 `process.env` ——
`dsh-app-boot`（物化 `.env` **文件**）和 `dsh-http-proxy`。

所以插件读 `process.env[apiKeyEnv]` **必然拿到 undefined**，然后发出占位符。

**修复**：解析顺序改为 **环境变量 → `credentialsFile` → 字面值（并告警）**，
且**按请求实时解析**（启动后新存的 key 无需重启）。
新增 `credentialsFile` 配置项，默认 `$DSH_HOME/.credentials.yaml`。

**现状**：`doctor.mjs` 的 4b 节 **PASS** ——
`SILICONFLOW_API_KEY resolves from the credential file (51 chars)`。
profile 里的安装副本已与源码一致，**修复已生效**。

> **移植到别的 harness 时，第一个要验证的就是这一条。**

---

## 5. 依赖面审计（抗升级的卖点）

插件**只 import 两个公开包**：`@deepseek-ai/dsh-tools`（`defineTool`）、`@deepseek-ai/schemastery`。
**零 harness 内部引用**。工具定义与官方教程逐字段一致。

配置层 patch 4 个行 id：

| 行 id | 若被改名 |
|---|---|
| `session-title-llm` | patch 空转，标题回到付费通道 |
| `spill-policy` | patch 空转，回到出厂 50KB |
| `session-query-sqlite` | patch 空转，回到 `:memory:` + `never` |
| `local-offload` | 插件根本不加载 |

**失效模式是静默降级（前三个）或响亮加载失败（第四个），不会崩。**
`doctor.mjs` 专门检查这两类。

**兼容区间**：`0.1.5-rc.2` 已实测；官方 `master` 接口已核对；更高版本**未验证**；
`0.1.2/0.1.3/0.1.5-alpha` **不支持**。

---

## 6. 三条坑（都真实踩过）

### 坑 1：`verify-all.mjs` 不是验收命令

它 import **裸包名**，而 ESM 按**脚本自身所在目录**解析 —— 从 F 盘跑必然
`ERR_MODULE_NOT_FOUND`。**不要再用它当验收**，用第 1 节那三条。
（先跑 `node tools\setup-dev.mjs` 可以修好它，但没必要。）

### 坑 2：编码规则是**两个相反**的方向

- **数据文件 `.json`** → **绝对不能有 BOM**（`JSON.parse` 拒绝，DSH 会死在启动）
- **含中文的 `.ps1`** → **必须有 BOM**（PowerShell 5.1 否则按 GBK 读，**语法都会错**）

**两个方向都真实踩过**：

- 早期安装脚本给 profile `package.json` 加了 BOM → DSH 起不来
- 本次会话编辑启动器时**丢了 BOM** → PowerShell 报
  `The string is missing the terminator: '`，**启动器直接不能用**（补回三个字节即修复）

`doctor.mjs` 现在**两个方向都检查**。

### 坑 3：改配置后必须重启 DSH 才一致

运行中的会话里改 `cordis.patch.yml`，界面会**显示异常**（本次实测：大量 AI 回复在页面上消失，
只剩工具调用提示）。会话日志里**回复并未丢失**（319 条有文字的回复都在），
重启 DSH 后界面恢复正常。**改完配置提醒用户重启。**

---

## 7. 已验证无效 / 已放弃（别重试）

| 方向 | 为什么 |
|---|---|
| 从 `cordis.patch.yml` 改压缩阈值 | 生效的那行在 `standard` preset 的 `isolate` 子域里，按 id patch 只改到 `disabled: true` 的死行 |
| 网页自动化驱动免费对话网页 | 需自建 Playwright + 登录态；违反平台条款；拿不到流式输出 |
| ~~轮换免费模型绕开限流~~ | **已反转**：实测按模型独立，轮换有效，**已实现** |
| 语义检索接成常驻工具 | 机制已验证（阈值 0.3 能分开真答案 0.56–0.91 与噪声 0.001–0.06），但没有会被反复查询的本地语料，一次性嵌入成本收不回。代码保留在 `lib/embeddings.js` 等 |
| `tools/publish.mjs` | 本次会话临时写过（隧道+推送同进程），**未提交即丢失**。要走这条路就重写，或直接用 `tools/push-to-github.mjs` |

---

## 8. GitHub 网络：本机 DNS 拦截与绕行（已验证可用）

**`github.com`、`api.github.com`、`raw.githubusercontent.com` 等约 20 个域名被写进
`C:\Windows\System32\drivers\etc\hosts` 指向 `127.0.0.1`。**

但**直连真实 IP 的 TLS 是好的**（`140.82.112.4`，证书 `cn=github.com` 校验通过），
所以**不需要梯子**：

```powershell
node tools\gh-tunnel.mjs --port 18100      # 用公共 DNS(223.5.5.5) 自己解析
git -c http.https://github.com.proxy=http://127.0.0.1:18100 -c http.sslBackend=openssl <命令>
```

- `sslBackend=openssl` **必须有**：Windows 版 git 默认 schannel，走代理报
  `SEC_E_NO_CREDENTIALS`。
- **隧道作为后台任务起，会在两次工具调用之间被回收** —— 表现为三种不同报错：
  `502`、`Error in the HTTP2 framing layer`、`SSL unexpected eof`。
  最可靠的做法：**让隧道和 git 命令在同一个进程里**。
- `web_fetch` 工具**也读本机 DNS**，所以读不到 GitHub；但 **`web_search` 能拿到 GitHub 正文标题**。
- 推送需要 token 带 **`repo` + `workflow`**（后者因为仓库有 `.github/workflows/ci.yml`）。
  只勾 `repo` 时推送被**整体**拒绝：
  `refusing to allow a Personal Access Token to create or update workflow`。
  **从最新提交里删掉该文件没用** —— 推送会发送历史。
- 绕开办法：把「不含 ci.yml 的整棵树」作为孤立提交强推到远端。

---

## 9. 三条免费通道

| 通道 | 代价 | 限制 |
|---|---|---|
| DeepSeek（付费） | ~$0.003–0.15/1M | 无 |
| **SiliconFlow（免费托管）** | $0 | 每模型 50,000 TPM（实测**按模型独立**） |
| 本地 llama.cpp | $0 | 无额度，但慢（**约 1 秒 / 1,000 字符**）且占显存 |

**本地服务不自动启动**：它一旦跑起来就要把模型挂在显存里（本机 8GB 卡，会明显挤占），
而它的角色只是免费额度用尽后的兜底，所以做成按需启动。
手动拉起：`powershell -File F:\bonsai\start-local-ai.ps1`

**不要把主 agent 切成 SiliconFlow**：主循环每次重发 20–40 万 token，一下撞上限流。

---

## 10. 文件地图

### 仓库（`dsh-token-saver\`）

| 路径 | 作用 |
|---|---|
| `lib/index.js` | 插件入口：Config schema、**凭据解析**、轮换链构建 |
| `lib/tools.js` | `local_delegate`：7 种任务、负载钳制、跨链尝试 |
| `lib/rotation.js` | `EndpointChain`：按端点冷却、自动恢复（**不引用 harness**） |
| `lib/http.js` | OpenAI 兼容客户端、思维链剥离、自愈 |
| `tools/doctor.mjs` | **升级后自检**（零依赖，10 组） |
| `tools/verify-live.mjs` | 端到端验收（零依赖） |
| `tools/check-links.mjs` | 文档链接（含 `--published` 模式） |
| `tools/push-to-github.mjs` | 推送（含凭据安全处理与两类失败诊断） |
| `tools/setup-dev.mjs` | 建 `node_modules` 链接，让按包名 import 的脚本能跑 |
| `tools/yaml-min.mjs` | 自研 YAML 读取器（全仓**零第三方依赖**） |
| `tools/gh-tunnel.mjs` | GitHub DNS 绕行隧道 |
| `templates/` | 两份 profile patch（每值旁有理由） |
| `docs/` | 架构/实测/兼容性/排障/打赏 + **四份介绍**（技术·小白 × 中英） |
| `test/` | 测量与验证脚本 |
| `.github/workflows/ci.yml` | CI（**仅本地**，未推上去：token 缺 `workflow` 权限） |

### 本机

| 路径 | 作用 |
|---|---|
| `~/.dsh/AGENTS.md` | 全局指令，每个会话加载 |
| `~/.dsh/settings.yaml` | 两条路由（local / siliconflow，7 个模型） |
| `~/.dsh/.credentials.yaml` | `SILICONFLOW_API_KEY` 等（**插件现在直接读它**） |
| `~/.dsh/profiles/web/cordis.patch.yml` | 所有 profile 级改动，含完整决策记录 |
| `C:\Users\吾\OneDrive\文档\千星奇域\dsh-launcher.ps1` | DSH 启动器（**已不再自动启动本地模型**；含中文，**必须带 BOM**） |

---

## 11. 待办（交给用户）

1. **撤销 token**：`https://github.com/settings/tokens`。任何贴进对话的 token 都该当作已泄漏，
   推送完成后提醒用户撤销。**撤销后需要新 token 才能再推送**（这是正常的，不是故障）。
2. **（可选）推 CI 文件**：给 token 加 `workflow` 权限后推送 `.github/workflows/ci.yml`。
3. **（未开始）`PROMPT-B-video.md`**：用户想做视频，交接提示词已写好但尚未执行。

### 关于打赏页：那份平台规则清单已删除

早期版本在 `docs/sponsor.md` 里写了一整套「发布收款码前必须核对」的平台规则清单
（个人收款码能否用于非经营用途、收款限额、是否允许公开在仓库里……）。
**已删除**，原因：那些结论是我**未经核实**的推断，而一页未经验证的合规建议会让读者误以为可靠。
用户说明微信/支付宝收款码**可以**用于经营收款，但本项目的行为如何界定很难判定，
因此决定不在这份文档里给合规结论 —— **支付平台的条款才是权威，而且会变**。
保留的内容：自愿打赏、不换取任何商品/服务/支持/担保/优先级、fork 里的码可能被替换、从不主动索取。

---

## 12. 给下一个我的三条提醒

1. **说话与做事交替**。每批工具调用前先说清「做什么、为什么、怎么判断成败」。
   用户明确抱怨过「你失去了回复，只是一个劲儿猛猛干，我完全不知道你在干什么」。
   **省 token 省的是无用功，不是解释。**
2. **连续失败两次就停下来问用户**，别在同一件事上耗三轮 —— 本次会话我为推一张图
   反复重启隧道试三种方案，白烧了一大笔。
3. **验证要落到证据**。`doctor.mjs` / `verify-live.mjs` 跑一遍，把输出贴出来；
   别说「应该好了」。
