# 写给 AI 的安装说明（直接复制给 AI 助手）

> **用法**：把本文件**整个内容**复制，粘贴给你正在用的 AI 助手（DSH 会话、Claude、Cursor、ChatGPT 等），
> 让它照着装。
>
> 它的目标是：**让你不用懂命令行，也能把 `dsh-token-saver` 装上并确认真的生效。**

---

## 请帮我安装 dsh-token-saver

这是一个给 **DSH（DeepSeek Harness）** 用的省 token 插件 + 配置方案。
它要做的事：**把庞大的文本挡在对话记录之外**，从而减少"每轮都被重发"的内容。

来源有两种：GitHub 仓库 `https://github.com/Resinzle/dsh-token-saver`，
或者我本地已经有的「完整资源包」（一个解压出来的目录，或一个 zip）。

### 关于我（使用者）

- 我是**编程小白**，你不要把选择权交给我，该你判断的你判断。
- **每一步都要用文字告诉我你在做什么、为什么**，不要一口气跑一堆命令不说话，我会完全不知道发生了什么。
- 遇到要联网或要我自己去网页上操作的事，**先说清楚要我去哪个网址、点什么**。
- 如果连续两次失败，**停下来问我要信息**，不要自己反复试。

### 第 0 步：先搞清楚"装成功"长什么样（重要，别跳过）

**光装插件是几乎省不到钱的。** 这个项目省钱的**最大单项是一个配置数字**
（把工具输出上限从出厂的 50KB 降到 12KB），它不在插件里，在配置里。
所以完整安装 = **装插件 + 应用配置**，两件都做完才算成功。

**成功标准（请逐条验证并给我看证据）**：

1. `dsh --profile web --dump-config` 里能看到 `local-offload` 这一行
2. 在仓库目录跑 `node tools/doctor.mjs`，**退出码 0**（它有 10 组检查，会打印每一项）
3. 配置里 `spill-policy` 的 `maxInlineBytes` 是 **12000**（不是出厂的 50000）
4. `node tools/verify-live.mjs` 能真的完成一次委派（这一步需要网络或本地模型）

**第 4 条做不到也没关系，但必须告诉我卡在哪** —— 因为这时"装上了"和"能省钱"是两回事。

### 第 1 步：确认 pnpm 可用

```sh
pnpm -v
```

如果报"命令未找到"：

```sh
npm install -g pnpm
```

### 第 2 步：把插件装进 web profile

**来源一：从 GitHub 直装**

```sh
dsh plugin --profile web add github:Resinzle/dsh-token-saver
```

> ⚠️ 这个包是**纯 JavaScript、无需构建**，所以不存在"从 git 装缺 lib/ 输出"的问题。
> 但它**带 `.gitignore` 里没有的** `lib/`，请装完后确认 `lib/index.js` 存在（见第 3 步）。
>
> 另外：GitHub 域名在某些网络环境下被 DNS 拦截（解析到 127.0.0.1）。
> 如果 `dsh plugin add` 因为连不上 GitHub 失败，**不要硬试**，直接用来源二（本地目录）。

**来源二：我本地已有完整资源包**

先确认资源包长什么样。它应该是一个**包含 `package.json` 的目录**，里面至少有：

```
package.json
cordis.yml
lib/index.js
lib/tools.js
lib/http.js
lib/rotation.js
README.md
```

然后：

**a) 如果给我的是 zip**：先解压到一个**固定、以后不会移动或删除**的目录，例如
`D:\Plugins\dsh-token-saver`（Windows）或 `~/dsh-token-saver`（macOS / Linux）。

**要装的是"包含 `package.json` 的那一层"，不是外面那个同名压缩包目录。**
（解压后如果不确定，请把这个层级结构展示给我看，让我确认。）

**b) 检查文件完整性** —— 任意一条不是 `True` 就先告诉我，不要继续：

```powershell
Test-Path "<资源包目录>\package.json"
Test-Path "<资源包目录>\lib\index.js"
Test-Path "<资源包目录>\cordis.yml"
```

并确认 `package.json` 里 `name` 字段是 **`dsh-plugin-local-offload`**，
且带有 **`dsh.bundle.patch`** 字段（指向 `./cordis.yml`）。

**c) 如果之前从 GitHub / npm 装过同名插件，先卸载**（避免版本冲突）：

```sh
dsh plugin --profile web remove dsh-plugin-local-offload
```

**d) 用绝对路径安装**（路径含空格要加引号）：

```sh
dsh plugin --profile web add link:<资源包目录>
```

- `link:` 是**软链接**：源目录改了**立即生效**，但装完后**不能移动或重命名**该目录；
  移动后必须重新执行一次 `add`。
- 想改成**拷贝安装**（源目录以后可以随便动，但要重装才生效）：

```sh
dsh plugin --profile web add file:<资源包目录>
```

### 第 3 步：验证插件装进去了

```powershell
# 检查依赖记录
Get-Content "$env:USERPROFILE\.dsh\profiles\web\package.json" | Select-String "dsh-plugin-local-offload"
# 检查文件真的落盘了
Test-Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-plugin-local-offload\lib\index.js"
```

两条都应为真。如果第二条是 `False`，说明装得不完整，**先别重启，把报错原文给我**。

### 第 4 步：应用配置（**这一步决定能不能省钱**）

仓库里有现成的配置模板，**二选一**：

| 模板 | 适合 |
|---|---|
| `templates/profile-patch.hosted.yml` | 用免费在线模型（硅基流动），本地模型只做兜底 —— **推荐** |
| `templates/profile-patch.local-only.yml` | 只用本地模型，不联网、不要 key |

**做法**：把选中的模板内容**合并进** `~/.dsh/profiles/web/cordis.patch.yml`。

> ⚠️ **两个坑，必须注意**：
> 1. DSH 的 patch 是**整行替换 config**，不是逐键合并。所以模板里**每个键都必须保留**，
>    不能只抄改动的那个。
> 2. 如果 `cordis.patch.yml` 已经存在且有内容，**不要整个覆盖** —— 请把模板的条目
>    **追加/合并**进去，并先备份原文件。

**推荐选 `hosted` 模板的话，还需要一个免费 API key**：

1. 让用户去 `https://cloud.siliconflow.cn/account/ak` 注册并复制 key（形如 `sk-...`）
2. key 存进 `~/.dsh/.credentials.yaml` 的 `refs:` 下面，键名 `SILICONFLOW_API_KEY`
3. 模板里对应的是 `apiKeyEnv: SILICONFLOW_API_KEY`

> ⚠️ **这一条是本项目踩过的真实大坑**：DSH 把 key 存在 `.credentials.yaml` 里，
> **但它不会把这个值导出成环境变量**。如果插件只读环境变量，就会拿到空值、
> 然后发一个占位符出去，结果**每次委派都报 401**。
> 本项目已修复：插件会**自己读 `.credentials.yaml`**（配置项 `credentialsFile`）。
> 所以模板里那行 `credentialsFile` **不要删** —— 删了就会 401。
>
> 注意：**不要**用 `Set-Content` / `Out-File -Encoding utf8` 写 `.credentials.yaml` 或任何
> `.json`（PowerShell 5.1 会写入 BOM，而 DSH 的 `JSON.parse` 不接受 BOM，会导致 DSH 起不来）。
> 用编辑器直接改，或用 Node 写。

### 第 5 步：如果 pnpm 拦截了构建脚本

pnpm ≥10 会拒跑依赖的 `prepare` 脚本。**本项目是纯 JS、没有构建脚本**，所以正常不会遇到。
若仍报 `allowBuilds` 相关错误：在 `~/.dsh/profiles/web/pnpm-workspace.yaml` 的
`allowBuilds` 下加对应 key，然后重跑。**加之前请先告诉我这个包为什么需要执行代码。**

### 第 6 步：重启 DSH，然后验收

**必须重启 DSH 服务端**（不是刷新页面）—— profile 的 bundle 列表只在启动时读一次。

重启后，在**项目目录**里跑：

```sh
node tools/doctor.mjs
```

**把它的完整输出给我看。** 退出码 0 才算通过。它会检查：
harness 版本、`defineTool` 接口是否变了、4 个配置行 id 是否还在、
**委派凭据能否真正取到**、安装副本是否与源码一致、依赖面、以及两个方向的编码规则。

然后（可选，需要网络或本地模型）：

```sh
node tools/verify-live.mjs
```

### 第 7 步：装完之后的日常使用

- 让 AI 处理大段文本时，**优先让它用 `local_delegate`**，而不是直接把全文读进对话。
- 这条规则已经写在 `~/.dsh/AGENTS.md` 里（如果你的 DSH 会读它），AI 会自动遵守。
- **省钱的第一杠杆是"少调用工具"**：每次多余的工具调用都要重发一遍全部历史。
  让 AI 想清楚再动手，不要试探式地连续调。

---

## 排查：常见的失败与含义

| 现象 | 含义 | 怎么办 |
|---|---|---|
| `dsh plugin add` 连不上 GitHub | 域名被 DNS 拦截（本机常见） | 改用本地目录安装（来源二），或先解决 DNS |
| 重启后 `--dump-config` 里没有 `local-offload` | 插件没被加进 bundle 列表 | 检查 profile 的 `package.json` 里 `dsh.profile.bundles` 是否含 `dsh-plugin-local-offload` |
| `doctor.mjs` 报**行 id 消失** | DSH 升级改了配置行名字 | 这是"静默降级"，不会崩；按 `docs/compatibility.md` 改 id |
| 委派报 **HTTP 401** | 凭据没取到（见第 4 步那个大坑） | 确认模板里的 `credentialsFile` 没被删、key 已写进 `.credentials.yaml` |
| 委派报 **429** | 免费额度用尽 | 插件会自动轮换到链上其他模型；等 65 秒自动恢复 |
| 委派**很慢（几十秒到几分钟）** | 走到了本地 llama.cpp 兜底 | 这是**设备决定**的：8GB 显存的机器约每 1,000 字 1 秒；显存更大明显更快。想快就把 key 配上用免费在线模型 |
| DSH **完全起不来** | `package.json` 被写入了 BOM | 跑 `node test/check-bom.mjs` 定位；用 Node 重写该文件 |

## 请 AI 遵守的边界

- **不要**声称"装好了"而没有 `doctor.mjs` 的退出码 0 作为证据。
- **不要**在没有把握时反复重试同一个命令；两次失败就停下来问我。
- **不要**把 API key 打印到对话里。
- 这个项目的实测数字来自**特定设备**（8GB 显存的消费级 A 卡）。
  讲"本地模型慢"时必须带上这个条件 —— **不谈条件谈效果是耍流氓**。

## 装完之后你可以问我

- 「怎么确认它真的省到钱了？」→ 用 `node test/cost-report.mjs` 看账单构成
- 「怎么加更多免费模型进轮换链？」→ 见 `templates/README.md`
- 「DSH 升级后怎么知道有没有失效？」→ `node tools/doctor.mjs`
- 「我完全不懂它原理」→ 读 `docs/intro-beginner.zh.md`（小白版）
