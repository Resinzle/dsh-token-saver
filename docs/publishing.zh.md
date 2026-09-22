# 从零发布到 GitHub（小白逐步版）

这份是给**还没有 GitHub 账号**的人写的。每一步都写清楚「点哪里、该看到什么、卡住了说明什么」。

已经在这台机器上**实测过**的部分会标注证据；没实测过的会明确标注「未实测」。

---

## 第 0 步：先搞清楚你的网络行不行

在这台机器上实测的结论（2026-02 实测）：

| 检查 | 结果 |
|---|---|
| `github.com` / `raw.githubusercontent.com` 的 DNS | **被污染**，解析到 `127.0.0.1` |
| 直连 GitHub 真实 IP 的 TLS | **正常**（证书校验通过，`cn=github.com`） |
| 本机 Node 访问 `registry.npmjs.org`、`gitee.com` | **正常** |
| PowerShell 的 `Invoke-WebRequest` | **失败**（它自己的旧 TLS 问题，与网络无关） |

**结论：这台机器的网络是通的，坏的只是 DNS 解析这一层。** 所以不需要买代理、不需要装梯子就能推送代码。

### 如果是同样的症状，用仓库自带的隧道

```powershell
# 1. 起隧道（保持这个窗口开着）
node tools\gh-tunnel.mjs

# 2. 让 git 走隧道；两步都要，缺第二步行不通
git config --global http.https://github.com.proxy http://127.0.0.1:18081
git config --global http.sslBackend openssl

# 3. 验证（不会改动任何东西）
git ls-remote https://github.com/deepseek-ai/deepseek-harness HEAD
```

第 3 步**实测输出**：返回一个真实的 commit hash 且退出码为 0。如果这里失败，后面都不用做。

第二行为什么必需：Windows 版 git 默认用 `schannel`，走代理时会报
`schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`。换成 openssl 后端即可，**这是实测踩到的坑**。

用完想撤销：

```powershell
git config --global --unset http.https://github.com.proxy
git config --global --unset http.sslBackend
```

> **注意**：隧道只解决 `git` / `GitHub` 的域名解析。**注册账号仍然需要浏览器**，而浏览器读的是系统代理设置（不是环境变量）。所以下面第 1 步建议直接用手机。

---

## 第 1 步：注册账号（手机上做，最省事）

**为什么用手机流量**：电脑上浏览器打不开 `github.com`（DNS 被污染），而手机流量通常没有这个问题。这是本机环境决定的，不是通用建议。

1. 手机**关掉 WiFi**，用流量。
2. 浏览器打开 `https://github.com/signup`。
3. 依次填：邮箱 → 密码 → 用户名（用户名会成为你仓库地址的一部分，比如 `https://github.com/你的用户名/dsh-token-saver`）。
4. **验证码（最常卡住的一步）**：
   - 如果图形验证码刷不出来，先换浏览器（Chrome / Edge / Safari）。
   - 还是不行就**换网络**（流量 ↔ WiFi 互换）再试。
   - 邮箱建议用常见邮箱（QQ / 163 / Gmail 都可以）。某些一次性邮箱域名会被拒。
5. 去邮箱点验证链接。

### 卡住了怎么判断是哪一类问题

| 现象 | 说明 | 怎么办 |
|---|---|---|
| 页面根本打不开 | 网络层就没通 | 换网络（流量/WiFi 互换），或换个手机 |
| 页面能开，验证码空白 | 验证码服务被墙 | 换浏览器或换网络重试；多试几次 |
| 提示用户名已存在 | 名字被占 | 换一个 |
| 邮箱收不到验证信 | 被丢进垃圾箱或被拒 | 先查垃圾箱；再换邮箱 |

**你不需要把密码或验证码告诉我。** 我不需要任何登录凭据。

---

## 第 2 步：创建 Personal Access Token（不是密码）

GitHub 从 2021 年起**不能用账号密码推送代码**，必须用 token。这一步在手机浏览器上也能做。

1. 手机打开 `https://github.com/settings/tokens`
2. 点 **Generate new token** → 选 **classic** 或 **fine-grained** 都行
3. 权限（**两个都要勾**）：
   - **classic**：勾 **`repo`**（整块）**和 `workflow`**
   - **fine-grained**：Repository access 选 All repositories，权限里把 **Contents** 设为 Read and write，另外把 **Workflows** 也设为 Read and write
4. 生成后**立刻复制**那一串（`ghp_...` 开头）。**页面一关就再也看不到**。

> **为什么必须多勾一个 `workflow`**（这是实测踩到的坑）：
> 本仓库带 `.github/workflows/ci.yml`。GitHub 规定：token 不能创建或修改 `.github/workflows/` 下的文件，除非它带 `workflow` 权限——这是为了防止 token 泄漏后被用来偷偷改 CI。
>
> 只勾 `repo` 时的报错长这样：
> ```
> ! [remote rejected] main -> main (refusing to allow a Personal Access Token to
>   create or update workflow `.github/workflows/ci.yml` without `workflow` scope)
> ```
> **注意这条报错说明认证是成功的**（token 是好的），只是少一个权限。补勾即可，不用重新生成。
>
> 另外：即使你把该文件从**最新**提交里删掉也没用——推送会发送整个历史，而它存在于更早的提交里。

### token 的安全边界（请认真读）

- token 等于你的写权限。**不要**发给任何人，包括我。
- 本仓库的 `tools/push-to-github.mjs` 支持 `--token`：它把 token 写进系统临时目录下一个权限为 `0600` 的文件，只让**那一条 git 命令**通过 `-c credential.helper=...` 读它，然后在 `finally` 里删除文件。**不会**写进 `.git/config`，也不会回显。
- 如果你不想把 token 交给脚本，就先让 Git 自己记住（走 Git Credential Manager），然后**不带 `--token`** 运行脚本。

**这几条已经过实测**（`node test/test-push-script.mjs`，21 项检查，全部通过）。测的是「token 不进 `.git/config`、不留凭据助手、不回显、临时文件即使推送失败也会删掉」——其中**失败路径**尤其重要，因为那才是会留下凭据的场景。

> **仍未在本机自动测试的一项**：完整的「推送成功」路径。测试用的本地 `git daemon` 在这台机器上无法接受推送——沙箱拒绝 socket 上的 `SO_KEEPALIVE`（`unable to set SO_KEEPALIVE on socket: Input/output error`），git 随后报 `the remote end hung up unexpectedly` 并挂住。这是环境限制，不是脚本问题。
>
> **不过凭据传递本身已经用真实 GitHub 验证过了**：修好三个 bug 之后，`--token` 让 git 成功通过了 GitHub 的认证——报错从「读不到用户名」变成了 GitHub 对文件权限的真实拒绝。也就是说「token 有没有送到 git 手里」这一段是**已证实的**。
>
> Git Credential Manager 的交互流程（不带 `--token` 的那条路）仍未实测，需要弹窗和真实账号。

---

## 第 3 步：建仓库

在手机上打开 `https://github.com/new`：

| 字段 | 填什么 |
|---|---|
| Repository name | `dsh-token-saver` |
| Description | 随便，例如 `Cut a DSH agent session's token bill by keeping bulky text out of the transcript` |
| Public / Private | 想开源就打 **Public** |
| Initialize with README | **不要勾**（我们本地已经有仓库了，勾了会冲突） |
| .gitignore / license | **都不要选**（仓库里已经有了） |

建完后你会得到一个地址，形如：

```
https://github.com/你的用户名/dsh-token-saver.git
```

---

## 第 4 步：推送（在电脑上一条命令）

```powershell
cd C:\Users\吾\OneDrive\文档\Resinzle\dsh-token-saver
node tools\push-to-github.mjs --remote https://github.com/你的用户名/dsh-token-saver.git --token 你的token
```

脚本会按顺序做六件事，每步都会打印结果：

1. 检查工作区，扫描有没有 `.json` 带 BOM（这是曾把 DSH 搞挂的坑）
2. 提交待提交的改动，把分支改名成 `main`
3. 检查隧道是否在跑；在跑就用，没跑就提示你起
4. 读一次远端（**只读，不写**），确认网络路径通
5. 推送，然后删除临时凭据文件
6. 打印仓库地址，方便你打开核对

先看要发生什么、不实际推送：加 `--status`。

### 报错怎么看

| 报错 | 原因 | 怎么办 |
|---|---|---|
| `403` | token 权限不够，或仓库不存在 | 检查 token 是否勾了 `repo`（classic）/ Contents 写权限（fine-grained）；确认仓库已建 |
| `401` | token 错、过期，或复制时多了空格 | 重新生成一个 |
| `schannel: ... SEC_E_NO_CREDENTIALS` | 没配 openssl 后端 | 回到第 0 步第 2 条 |
| `Could not resolve host: github.com` | 没起隧道，或没配 proxy | 回到第 0 步 |
| `remote: Support for password authentication was removed` | 用密码而不是 token | 用 token |

---

## 第 5 步：推完之后

1. 手机或电脑打开仓库页面，确认文件都在、README 正常显示。
2. 在仓库页面右上 **About** 处补 Description 和 Topics，建议：
   `dsh`、`deepseek-harness`、`tokens`、`context`、`llm`、`cost-optimization`
3. （可选）在 `https://github.com/你的用户名/dsh-token-saver/settings` 里把默认分支确认为 `main`。

---

## 不会用命令行怎么办

这份文档里的命令都可以直接复制粘贴到 PowerShell 里跑，不需要你理解语法。所有脚本的价值就是「把容易出错的步骤固化成一条命令」。

如果某一步的报错不在上面那张表里，把**报错原文**发给我。判断需要三样东西：`node tools/doctor.mjs` 的输出、报错原文、以及你卡在第几步。
