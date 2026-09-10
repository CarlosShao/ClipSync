# 桌面端发布流程（GitHub Releases + Tauri 签名）

> 适用：ClipSync 桌面端（Tauri v2）自动更新链路。
> 托管方案：**GitHub Releases**，仓库 [`CarlosShao/ClipSync`](https://github.com/CarlosShao/ClipSync)。
> 相关文档：[github-secrets.md](./github-secrets.md)（签名私钥配置）。

## 链路总览

```
本地打 tag v0.2.0 → 推送 → GitHub Actions 构建 + 签名
                                   │
                                   ├─ 产物 .exe / .nsis.zip 上传到 Release（tag v0.2.0）
                                   └─ 生成 .sig 签名文件
                                            │
                    管理台 /releases 建版本单 ─┘
                    （填 version + platforms.windows-x86_64.url + signature）
                                            │
                                            ▼
                    发布单 is_published=true（写库 + 60s 内客户端可见）
                                            │
                                            ▼
        客户端 GET https://updates.clipchain.top/api/app/updates/latest
        ?target=windows-x86_64&current_version=0.1.0
                                            │
        服务端比对 app_releases 最新已发布版本 ─┤
                                            ▼
        200 { version, notes, pub_date, platforms: { "windows-x86_64": { url, signature } } }
                                            │
                    Tauri 用公钥验签 → 通过则下载安装，不通过则拒绝
```

**三个必须同时对齐的东西**（缺一更新链路就断）：

| # | 东西 | 在哪 | 对不上的表现 |
|---|---|---|---|
| 1 | 签名**公钥** | `src/desktop/src-tauri/tauri.conf.json` → `plugins.updater.pubkey`（烧在客户端里） | 客户端拒绝安装（验签失败） |
| 2 | 签名**私钥** | GitHub Secret `TAURI_SIGNING_PRIVATE_KEY`（CI 用它签名） | 同上（包没签名或签名不符） |
| 3 | 产物**下载地址** + **signature** | 管理台 `/releases` 版本单的 `platforms` 字段 | 客户端 404 / 找不到更新 |

> 🔑 **公钥必须与私钥配对**。换私钥 = 必须换公钥并重发客户端。

## 一、准备（首次只需做一次）

1. **生成签名密钥对**（见 [github-secrets.md](./github-secrets.md) 的「生成本地签名密钥对」）：
   ```bash
   cd src/desktop
   npx tauri signer generate -- -w ~/.tauri/clipsync.key
   ```
2. **公钥入仓**：`~/.tauri/clipsync.key.pub` 整行内容 → `tauri.conf.json` 的 `plugins.updater.pubkey`
3. **私钥入 GitHub Secrets**：`TAURI_SIGNING_PRIVATE_KEY`（全文）+ `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（口令；无口令则空串）
4. **配置下载地址来源**（服务端二选一，也可都不配、只在版本单里填全 URL）：
   - 管理台 → 系统设置 → 「更新包下载地址」填 `https://github.com/CarlosShao/ClipSync`
   - 或部署环境变量 `RELEASE_DOWNLOAD_BASE_URL=https://github.com/CarlosShao/ClipSync`

## 二、发布一版（每次）

### Step 1 改版本号

`src/desktop/src-tauri/tauri.conf.json` 的 `version` 字段（同时留意 `src/desktop/package.json`），
提交后打 tag —— **tag 必须是 `v<version>` 形态**（服务端按该形态拼下载 URL）：

```bash
# 例：version 改为 0.2.0
git tag v0.2.0
git push origin v0.2.0
git push cnb v0.2.0          # 双远端，见 AGENTS.md
```

### Step 2 构建 + 签名

CI 侧（或本地）打包，`TAURI_SIGNING_PRIVATE_KEY` 由 GitHub Secrets 注入：

```bash
# 本地验证打包（可选；签名需先导出私钥到环境变量）
cd src/desktop
npx tauri build
```

产出（`src/desktop/src-tauri/target/release/bundle/`）：

| 文件 | 用途 |
|---|---|
| `nsis/ClipSync_0.2.0_x64-setup.exe` | 安装包本体 |
| `nsis/ClipSync_0.2.0_x64-setup.exe.sig` | **Tauri 更新签名**（内容要填进版本单的 `signature`） |
| `nsis/ClipSync_0.2.0_x64-setup.nsis.zip` | Tauri updater 实际下载的增量包 |
| `nsis/ClipSync_0.2.0_x64-setup.nsis.zip.sig` | 对应签名 |

> ⚠️ 只有 `tauri.conf.json` 里 `bundle.createUpdaterArtifacts: true` 时才会产出 `.sig` 与 `nsis.zip`。
> 本仓库已设 `true`。

### Step 3 上传到 GitHub Release

把安装包本体 + `.sig` + `nsis.zip` **全部**上传到 tag `v0.2.0` 的 Release。

下载 URL 形态（服务端按此拼）：

```
https://github.com/CarlosShao/ClipSync/releases/download/v0.2.0/<filename>
```

> ⚠️ Release 必须是**已发布**状态（不能是 draft），否则匿名下载 404。

### Step 4 在管理台登记版本单

管理台 → **版本发布**（`/releases`）→ 新建：

| 字段 | 填什么 |
|---|---|
| `version` | `0.2.0`（建单后不可改） |
| `notes` | 更新说明（客户端弹窗展示） |
| `platforms` | `{ "windows-x86_64": { "url": "<GitHub Release 下载地址>", "signature": "<.sig 文件全文>" } }` |
| `rollout_percent` | `100` 全量；灰度发布填 10 则约 10% 客户端可见（分桶稳定） |
| `force_update` | 强更开关 |
| `is_published` | 先存草稿（false）→ 核对无误再置 true |

`platforms.windows-x86_64.url` 可以省略——省略时服务端按
「`RELEASE_DOWNLOAD_BASE_URL` 环境变量 / `system_configs.release_download_base_url`」自动拼
`https://github.com/CarlosShao/ClipSync/releases/download/v0.2.0/ClipSync_0.2.0_x64-setup.exe`。
**但 `signature` 必须显式填写**（服务端不生成签名）。

> 🔎 自动拼 URL 时用的是 `platforms[target].filename`；不填 filename 则按 Tauri NSIS 默认命名
> `ClipSync_<version>_x64-setup.exe` 推。**实际产物名不一致时必须显式填 `filename`**，否则 404。

### Step 5 发布 + 验证

把 `is_published` 置 `true`（写库后 ≤60s 客户端可见，服务端有 60s 进程内缓存）。

```bash
# 服务端视角
curl -s "http://localhost:3001/api/app/updates/latest?target=windows-x86_64&current_version=0.1.0"
# 期望：200 + { version:"0.2.0", platforms:{ "windows-x86_64":{ url, signature } } }
# 已是最新 / 灰度未命中 / 无产物 → 204 No Content

# 下载地址确实可达（把 url 换成上一步返回值里的）
curl -sI "https://github.com/CarlosShao/ClipSync/releases/download/v0.2.0/ClipSync_0.2.0_x64-setup.nsis.zip"
```

最后在客户端跑一次「检查更新」。

## 三、更新端点

| 环境 | 端点 | 说明 |
|---|---|---|
| 生产 | `https://updates.clipchain.top/api/app/updates/latest?target={{target}}&current_version={{current_version}}` | `tauri.conf.json` 内置，release 包强制 https |
| 本地调试 | `CLIPSYNC_UPDATER_ENDPOINT` 环境变量覆盖为 `http://localhost:3001/api/app/updates/latest?...` | 仅 debug 构建允许非 https |

## 四、常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| 客户端报「更新服务未配置」 | `plugins.updater.pubkey` 仍是 `placeholder_pubkey_replace_in_production` | 填入真实公钥（Step 1-2） |
| 客户端提示有更新但安装失败 | 签名不匹配（私钥 ≠ 公钥） | 核对 Secrets 里的私钥与仓库里的公钥是否同一对 |
| 下载 404 | Release 是 draft / tag 不是 `v<version>` / filename 与实际不符 | 检查 Release 状态与 `platforms.filename` |
| 端点返回 `410 下载地址未配置` | 版本单既没填 `url`，也没配 `RELEASE_DOWNLOAD_BASE_URL` / 配置键 | 二选一补上 |
| 客户端一直说已是最新 | `app_releases` 无 `is_published=true` 行，或 `rollout_percent` 未命中，或版本号未大于客户端当前版本 | 查版本单状态 |

## 五、回滚

管理台 → 版本发布 → 把该版本单 `is_published` 置 `false`（**撤回**）。
客户端 ≤60s 后不再提示该更新。已升级的客户端不会自动降级，需重装旧版安装包。

## 六、服务端行为约定（GH-01）

`GET /api/app/update.json`（**存量客户端**兼容端点）在「平台无产物」时**不再伪造下载链接**：

- 旧行为：回退 `https://example.com/downloads/...` —— 客户端真去请求，404/超时，根因不可见
- 现行为：`410 Gone` + `{ error: "下载地址未配置", unconfigured: "RELEASE_DOWNLOAD_URL_NOT_CONFIGURED", version }`

下载地址解析优先级（`src/server/src/utils/releaseArtifacts.js`）：

1. `app_releases.platforms[target].url`（发布单显式地址，逐版本覆盖）
2. `RELEASE_DOWNLOAD_BASE_URL` 环境变量（部署级覆盖）
3. `system_configs.release_download_base_url`（管理台可改，迁移 067）
4. 都没有 → 明确报「未配置」，**绝不返回占位域名**

`GET /api/app/updates/latest`（**当前客户端**使用）行为不变：无产物 → `204 No Content`
（Tauri 视为已是最新，不报错）。

## 七、遗留

- `src/desktop/src-tauri/tauri.conf.json` 的 `bundle.targets` 目前只有 `nsis`（Windows）。
  macOS / Linux 产物需补 target，且 `platforms` 里补 `darwin-aarch64` / `linux-x86_64` 条目。
- 尚无 GitHub Actions 自动打包 workflow（当前 `release-desktop` job 未落地），
  Step 2 的构建目前需本地或手动触发。
