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

### 2. 未来扩展（按需加）

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