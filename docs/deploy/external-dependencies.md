# ClipSync 外部依赖任务清单（唯一真相源）

> **本文是外部依赖状态的唯一真相源**，2026-10-07 按**实测**重写。
> 旧清单已合并进来，另两处只保留历史价值：
> - `docs/production-roadmap/external-dependencies.md` → 内容已清空，仅留指向本文的指针
> - `docs/audit/external-dependency-audit-2026-09-09.md` → **保留申请/注册教程**（仍有价值），其状态列为"审计当时"快照
>
> **冲突时以本文为准。**

## 0. 一句话现状（2026-10-10 实测复核）

- 生产已上线：`*.clipchain.top` + HTTPS、5 个容器、**迁移 090 已应用**、服务端 `version 0.3.0`
- **外部依赖配置已全部就位**（2026-10-10 直查生产库）：短信 5 键（aliyun，签名/模板齐）· 邮件通道 1 条 ·
  Sentry DSN + API Token · Turnstile site/secret（**开关默认关**，等移动端）· GitHub/Microsoft OAuth（Microsoft 用 `common`）·
  `release_download_base_url` = `https://www.clipchain.top/downloads` · `maintenance_mode=off`
- **§2.1–2.4 四项（曾判为阻塞/待做）已于 2026-10-07～10-10 全部完成并生产验证**，详见 §2 开头
- 剩余待办全部是「**只有你能办**」的（商店/备案/证书/新渠道）或「走你拍板的增强」，**不阻塞运营**

---

## 1. 已完成（曾是外部依赖，现在不是）—— 别再照旧清单当阻塞

| 事项 | 旧清单说 | 实测证据（2026-10-07） |
|---|---|---|
| 根域名 + DNS + 服务器 | 🚫 阻塞 | ✅ `clipchain.top` 已解析，生产 5 容器在跑 |
| HTTPS / TLS | 🚫 阻塞 | ✅ `https://api.clipchain.top/api/health` → 200 |
| 支付宝支付 | 🚫 阻塞 | ✅ 生产 env 含 6 个 `ALIPAY_*`；下单/回调/退款已生产实测 |
| 短信**代码**能力 | "纯 mock / 固定码 888888" | ✅ 真实现：`utils/sms.js` + 迁移 068 的 4 个键；生产**强制随机码**、未配置返 **503**、绝不降级（`auth-verify.js:46-49,63-77`） |
| 邮件**代码**能力 | "代码就绪，管理台未填" | ✅ 更好了：`email_channels`（迁移 059）+ 管理台「邮件通道」卡（多账号 / 用途路由 / failover） |
| 对象存储 S3 依赖 | "依赖没装根本跑不起来" | ✅ `@aws-sdk/client-s3` 已在 `src/server/package.json`；`storage.js` / `admin/ops.js` 均可用（切 `STORAGE_TYPE=s3` 即生效） |
| 更新链路 | "example.com 兜底 / `hasUpdate` 硬编码" | ✅ `app.js:338` 真比较版本；`releaseArtifacts.js:135`「未配置就明确告知，绝不伪造 example.com」；Tauri **公钥已是真 minisign 公钥**；`updates.clipchain.top` 端点可达；生产 `release_download_base_url` **已配** |
| 官网 download-links | "数据文件缺失" | ✅ `src/website/src/data/download-links.ts` 存在 |
| `METRICS_TOKEN` 默认公开串 | "硬编码" | ✅ `index.js:361` 改为计算生成 |
| Android 正式签名 | "release 用 debug 签名" | ✅ `src/mobile/android/key.properties` **已存在** → release 走正式签名（缺文件才回退 debug） |

---

## 2. 待办（按"卡不卡运营"排序）

### 2.0 ✅ 先读这里：§2.1–§2.4 四项已全部完成（2026-10-10 复核，下面是历史记录）

| 当时 | 现在 | 证据 |
|---|---|---|
| §2.1 短信/邮件凭据没同步（"唯一阻断"） | ✅ **5 键全配 + 邮件通道 1 条** | 10-10 直查生产库：`sms_provider=aliyun`、签名/模板/AccessKey 三键齐、`email_channels` 1 行 |
| §2.2 Sentry 只差 DSN | ✅ **DSN + API Token 均已配**，管理台「最近错误」卡可用（迁移 086/087） | 10-10 直查库；用户曾在后台看到自检事件 |
| §2.3 CAPTCHA 未实现 | ✅ **已实现**：迁移 088 + 三条发码门控 + 桌面/管理台挂件（089 后补客户端流）；**真钥已配、开关默认关**（等移动端 3.3） | 10-10 直查：`turnstile_site_key/secret` SET、`enabled=false` |
| §2.4 GitHub OAuth 待建 App | ✅ **两家都可登录**：GitHub 走**客户端设备码流**（服务端到 github.com 不稳 + 浏览器 CORS 拦）、Microsoft 走服务端轮询（tenant=`common`） | 10-10 用户生产实测两家均登录成功；细节见记忆 `project-external-auth-state` |

**剩余待办只有两类**：①只有你能办的（§2.5–2.7：新支付渠道 / 分发证书 / 备案与商店）；②走你拍板的增强（§2.8）。
另有**代码侧遗留**（不需要任何外部账号，我方可直接做）：
`resolveOrCreateUser` 补测试（10-09/10-10 两次生产事故都出在这条无测试的路径上）·
桌面端 3 处设备注册去重（启动时会 201+409 各一次，无害但控制台红）·
admin-console 5 处既有 lint error（prettier/`no-base-to-string`）·
把生产现场 nginx 配置收进仓库（每次部署都要人工避雷，见 `docs/audit/prod-branch-divergence-2026-10-08.md` §7）。

**§2.1–2.4 的历史记录（保留：根因分析仍有价值，运维约定仍有效）**

### 2.1 ✅（已完成）短信 / 邮件凭据同步到生产

**现象**：部署版管理台点「发送验证码」→ 收不到短信。生产日志：

```
[sms] 短信未配置，无法发送验证码
[send-code] 短信下发失败，拒绝发送验证码  reason:"not_configured"     （HTTP 503）
```

**根因（已查明，不是代码问题）**：运行时配置是**环境私有**的，落在 `system_configs` / `email_channels`，
**不进迁移、不随代码走**。

| | 本地库 `clipsync_dev` | 生产库 |
|---|---|---|
| 短信 5 键 | **全填**（`sms_provider="aliyun"` 等） | **全空**（`sms_provider="console"`） |
| 邮件通道 | 1 行（`smtp.qq.com:465`） | **0 行** |
| 配置写入审计 | 有：`admin.config.sms_test {"success":true,"provider":"aliyun","requestId":"01A0A56D-…"}`（09-15 22:17）、`admin.config.smtp_test {"success":true,"messageId":"…@qq.com"}`（09-11 20:07） | **0 条** |
| 库的来历 | 你的开发库 | **09-15 23:40 由 74 个迁移全新建的独立库** |

→ 你填配置在 **09-15 21:41**，生产库 **23:40** 才建起来；**生产从没拿到那份配置**，所以发码必 503。

**谁做**：你（密钥不该经他人手）。**周期**：10 分钟。

**填哪里**：部署版管理台 `admin.clipchain.top` →
- 系统参数：`sms_provider`（改 `aliyun` / `tencent`）、`sms_access_key_id`、`sms_access_key_secret`、`sms_sign_name`、`sms_template_code`
- 「邮件通道」卡：新增一条（`smtp.qq.com:465`、SSL、账号、**授权码**、发件人）

**两个坑**：
1. `sms_access_key_secret` / `smtp_pass` 在管理台**只显示「已配置」不回显**（设计如此）→ 去**阿里云控制台**重新取 AccessKey（记不得就新建一个）、**QQ 邮箱重新生成授权码**；
2. **不能直接拷本地库那串密文** —— 它是用**本地 `ENCRYPTION_KEY`** 加密的，生产用另一把钥匙，拷过去解不开。

**怎么验**：管理台「发送测试短信 / 测试邮件」成功 → 生产日志出现 `[sms]` 发送成功 + 审计 `admin.config.sms_test` 带 requestId → 再用真实手机号走一遍登录。

**运维约定（防复发）**：新建/重建环境后，按本节逐项补配置；`backup-prod` 的 dump 会带上这两张表，**重建前**先确认能回填。

### 2.2 ✅（已完成）Sentry 错误追踪

- **现状**：接线已完成并部署（分支 `b1f5aa59`、生产 `2f4511b`+`08abcda`，迁移 **086** 已应用）。
  配置项 `sentry_dsn` 已在管理台「系统参数」目录里，**留空 = 不启用（全程 no-op）**
- **谁做**：你注册 https://sentry.io/signup/ → 建 **Node.js** project → 复制 DSN
  （形如 `https://<key>@o<org>.ingest.sentry.io/<project>`）→ **管理台 → 系统参数 → Sentry DSN → 保存**
  （保存即失效缓存并重初始化，**不用重启容器**）
- **上报范围**：未捕获异常、unhandledRejection、**仅 5xx**（4xx 不上报，避免淹没真实故障）
- **隐私**：`sendDefaultPii:false` + `tracesSampleRate:0` + `beforeSend` 剔除请求体 / Cookie /
  Authorization / 含 phone|token|code 的 query / 手机号邮箱密钥剪贴板字段 / 整个 user 段（有 15 例测试钉住）
- **怎么验**：填完保存 → 发一条测试错误 → Sentry Issues 出现该事件
- **备选**：网络不稳可换自托管 **GlitchTip**（同 DSN 协议，直接填它的 DSN 即可）

### 2.3 ✅（已完成）CAPTCHA 人机验证

- **现状**：未实现（`TURNSTILE*` / `RECAPTCHA*` 全空）
- **谁做**：你注册 Cloudflare Turnstile（免费）→ 我接入注册/发码接口并在管理台做开关

### 2.4 ✅（已完成）GitHub / Microsoft OAuth

- **现状**：桌面端登录/注册页共 **7 个**品牌按钮全是空占位（点了只弹「注册流程即将推出！」）：
  登录页 WeChat / Apple / **GitHub** / WeCom（`AuthPage.vue:767,777,784,791`）、注册页 WeChat / Apple / **GitHub**（`:1006,1016,1023`）
- **决定**：只做 **GitHub**，用 **Device Flow**（应用内显示 8 位码 → `github.com/login/device` 输入）——
  **不需要回调域名、不需要备案、不必改 Rust 侧**；WeChat / Apple / WeCom **隐藏**（代码路径留着，账号+备案齐了再开）
- **谁做**：你在 https://github.com/settings/developers 建 OAuth App 并勾 **Enable Device Flow** → Client ID 交给开发侧；
  Client Secret 填进配置项（**不要贴聊天、不要进提交**）+ 我做前后端与测试

### 2.5 🟢 P2 支付扩渠道

| 事项 | 谁做 | 周期 | 备注 |
|---|---|---|---|
| 微信支付商户号 | 你 | 1-2 周 | 代码侧有骨架；UI 已是「微信支付 · 暂未开放」禁用占位 |
| Stripe | 你 | 1-3 天 | 未实现 |

### 2.6 🟢 P2 分发（Windows / macOS）

| 事项 | 谁做 | 周期 |
|---|---|---|
| Windows 代码签名证书 | 你（¥1500-6000/年） | 1-3 周 |
| macOS 公证（需 Apple 开发者账号 $99/年） | 你 | 3-7 天 |
| 真打一个签名包并上传（链路已就绪） | 你 / 我 | 半天 |

### 2.7 🟢 P2 国内安卓分发 —— **最长关键路径**

| 事项 | 状态 | 周期 |
|---|---|---|
| 软件著作权 | **进行中（提交 1 个月，尚未受理）** | 受理后 40-60 工作日 |
| 网站 / 域名 ICP 备案 | ✅ **已完成**（`clipchain.top`） | — |
| **APP 备案**（工信部，与网站备案是两套） | ❌ 未办 | 10-30 工作日 |
| 华为 / 小米 / OPPO / vivo 商店账号 | ❌ 未注册 | 各 1-3 天 |

### 2.8 🟢 P3 增强（不阻塞）

| 事项 | 现状 | 谁做 |
|---|---|---|
| 对象存储（OSS / MinIO） | 代码就绪；生产 `STORAGE_TYPE` 未设（= local） | 你定 |
| 推送（FCM / APNs / 国内厂商） | 未集成 | 你申请 + 我接 |
| 密钥管理 Vault | 未做（现为 env + 运行时配置） | 你定 |
| Grafana / 监控栈、自动扩缩容 | 未部署 | 你定 |
| 飞书告警 webhook | 未接（现由管理台「待处理事项」兜底） | 你定 |

---

## 3. 变更记录

- **2026-10-10**：按实测复核——§2.1（短信/邮件）、§2.2（Sentry）、§2.3（CAPTCHA）、§2.4（OAuth）**四项均已完成并生产验证**，
  新增 §2.0 现状表与"代码侧遗留"清单（见 §2.0 末）。生产已升级到分支 tip（`version 0.3.0`、迁移 090）。
- **2026-10-07**：按实测重写；合并 `production-roadmap/external-dependencies.md`；查明 §2.1 根因（配置在本地库、生产库 09-15 重建后从未同步）
- **2026-09-09**：全量审计 33 项（申请/注册教程见 `docs/audit/external-dependency-audit-2026-09-09.md`）
- **2026-06-24**：初版
