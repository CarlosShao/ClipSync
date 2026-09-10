# GitHub Secrets 配置清单

> ⚠️ **重要**: 本文件包含变量名清单（不含真实值）。所有密钥/密码都配置在 GitHub 仓库的 **Settings → Secrets and variables → Actions → New repository secret**，绝不要写在代码或本文件里。

## 为什么需要这个

CI/CD 流水线（`.github/workflows/ci.yml`）在自动化部署时需要以下敏感信息。它们**不能**写在代码里（一旦 push 到 git 就永久泄露），所以存到 GitHub 自己的加密保险库。

## 必需的 Secrets（按 job 分组）

### 1. 自动部署（`deploy` job 使用）

| Secret 名称 | 作用 | 获取方式 |
|---|---|---|
| `DEPLOY_HOST` | 服务器 IP 或域名（如 `1.2.3.4` 或 `clipsync.example.com`） | 你服务器的地址 |
| `DEPLOY_USER` | SSH 登录用户名（如 `root` 或 `ubuntu`） | 服务器上的 SSH 用户 |
| `DEPLOY_SSH_KEY` | SSH 私钥（**完整内容**，含 `-----BEGIN OPENSSH PRIVATE KEY-----` 头尾） | 本地 `~/.ssh/id_rsa` 全文 |

> 没配置这三个 secrets 也没事——`deploy` job 会自动跳过（已设 `continue-on-error: true`），不会导致 CI 失败。

### 2. 桌面端自动更新签名（`release-desktop` / Tauri 打包使用）—— **必须配置**

Tauri updater 用**非对称签名**保护更新包：私钥在 CI 里签名，公钥内置在客户端（`src/desktop/src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`）。
客户端只接受**用对应私钥签名**的更新包——这是更新链路的唯一信任根，配错 = 客户端拒绝安装所有更新。

| Secret 名称 | 作用 | 获取方式 |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri 更新签名私钥（**完整内容**，即 `npx tauri signer generate` 产出的 `~/.tauri/clipsync.key` 全文） | 见下方「生成本地签名密钥对」 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥口令 | 生成密钥时设置的口令；**若生成时未设口令，此 secret 留空字符串**（不能省略，Tauri CLI 会读它） |

> ⚠️ 这两个 secret 缺失时，`tauri build` **不会**签名更新包，但产物仍会生成——
> 客户端拿到未签名/签名不符的包会拒绝安装（表现为「更新失败」而非构建失败）。属静默故障，务必先配。

#### 生成本地签名密钥对

```bash
# 在 src/desktop 下执行（CLI 随 @tauri-apps/cli 已装，无需全局安装）
cd src/desktop
npx tauri signer generate -- -w ~/.tauri/clipsync.key

# 交互提示会要求设置口令（password）：
#   - 设了口令 → 同时配 TAURI_SIGNING_PRIVATE_KEY_PASSWORD
#   - 直接回车跳过 → TAURI_SIGNING_PRIVATE_KEY_PASSWORD 配空字符串
```

产出两个文件：

| 文件 | 用途 | 入库？ |
|---|---|---|
| `~/.tauri/clipsync.key`（私钥） | 填 `TAURI_SIGNING_PRIVATE_KEY`；本地打包时也可用 | ❌ **绝不入库** |
| `~/.tauri/clipsync.key.pub`（公钥） | 填 `tauri.conf.json` 的 `plugins.updater.pubkey` | ✅ 必须入库（客户端内置） |

配置步骤：

```bash
# 1. 公钥写入仓库（明文，公开信息）
#    把 ~/.tauri/clipsync.key.pub 的整行内容填进：
#    src/desktop/src-tauri/tauri.conf.json → plugins.updater.pubkey

# 2. 私钥写入 GitHub Secret（完整内容，含换行）
#    GitHub → Settings → Secrets and variables → Actions → New repository secret
#    Name: TAURI_SIGNING_PRIVATE_KEY
#    Value: cat ~/.tauri/clipsync.key 的全文
```

> 🔒 **私钥纪律**：私钥只存在于两处——你的本机 `~/.tauri/` 和 GitHub Secrets。
> 永远不要 `git add` 它，不要贴进 issue/聊天记录，不要写进 `.env`（`.env` 也可能被误提交）。
> **私钥丢失 = 无法再发布任何更新**（只能让全部客户端手动重装带新公钥的版本），请离线备份。

#### 轮换密钥

轮换比 SSH key 麻烦得多——**公钥烧在客户端里**：

1. 生成新密钥对，公钥写进 `tauri.conf.json`，随**正常更新流程**发一版（老客户端用旧公钥验签，此版仍需用**旧私钥**签名）
2. 等新公钥版本的用户覆盖率足够高后，才能切用新私钥签名
3. 期间两个私钥都要保留；GitHub Secrets 只能存一个值，故轮换窗口内**不要**改 secret，改用其他方式注入新私钥

### 3. 未来扩展（按需加）

| Secret 名称 | 作用 | 何时需要 |
|---|---|---|
| `DOCKERHUB_USERNAME` | Docker Hub 用户名 | 如果你想把镜像推到 Docker Hub 而不是 GHCR |
| `DOCKERHUB_TOKEN` | Docker Hub Access Token | 同上 |
| `PROD_DB_PASSWORD` | 生产数据库密码 | 如果 CI 需要跑生产环境迁移（一般不需要，迁移在服务器上跑） |
| `SLACK_WEBHOOK` | Slack 通知 webhook | 想让 CI 失败时推送到 Slack |
| `DISCORD_WEBHOOK` | Discord 通知 | 同上 |

## 配置步骤

1. 进入 GitHub 仓库 → 点击 **Settings**
2. 左侧菜单 → **Secrets and variables** → **Actions**
3. 点击 **New repository secret**
4. 填 Name（如 `DEPLOY_HOST`）+ Value（如 `1.2.3.4`）
5. 重复添加所有需要的 secrets
6. 完成后下次 push 到 master 自动生效

## 如何生成 SSH key 给 `DEPLOY_SSH_KEY`（如果还没生成）

```bash
# 本地终端
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/clipsync_deploy
# 把公钥加到服务器 authorized_keys
cat ~/.ssh/clipsync_deploy.pub | ssh user@server "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
# 把私钥全文（含头尾 -----BEGIN/-----END-----）复制到 GitHub Secret
cat ~/.ssh/clipsync_deploy
```

## 如何修改/轮换密钥

服务器上换密码后，只需更新 GitHub Secret 对应项，**下次 CI 运行自动用新值**，无需改任何代码。

## 紧急情况

如果密钥泄露（曾误提交到 git）：
1. **立即**重新生成（数据库密码 / JWT secret / SSH key）
2. 更新服务器
3. 更新 GitHub Secrets
4. 用 `git filter-branch` / `git filter-repo` 从历史清除旧密钥
5. 强制 push
