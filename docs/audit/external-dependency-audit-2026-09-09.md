# ClipSync 外部依赖全量审计 + 申请/注册教程（2026-09-09）

- **目的**：把「要对外申请、注册、购买、备案」的事项一次性列全，每项给可照做的申请教程（入口 → 材料 → 步骤 → 产出凭据 → 填到哪里 → 怎么验证）
- **方法**：全仓 `process.env.*` 枚举 + 硬编码外部域名扫描 + 客户端/分发配置交叉核对（证据均带 `文件:行`）
- **结论先行**：仓库里**没有任何一个外部服务账号处于"已配置"状态**。所有支付/短信/推送/签名/更新服务都是 placeholder 或 mock。
- **相关旧文档**：`docs/deploy/external-dependencies.md`、`docs/product/payment-integration-guide.md`、`docs/product/domestic-android-publish-guide.md`（本文为最新合并版，冲突以本文为准）

---

## 0. 总览：33 项外部依赖，按"卡不卡上线"排序

| # | 事项 | 类别 | 周期 | 费用 | 状态（代码实证） |
|---|---|---|---|---|---|
| A1 | 根域名 + DNS + 服务器 | 上线阻断 | 1-2 天 | 域名 ~¥60/年 | ❌ 未配（已有域名 `clipchain.top`，待统一 + 解析） |
| A2 | HTTPS 证书（Let's Encrypt） | 上线阻断 | 1 小时 | 免费 | ❌ 仅声明 cert-manager |
| A3 | SMTP 邮件服务 | 上线阻断 | 10 分钟 | 免费/低 | ⚠️ 代码就绪，**管理台未填** |
| A4 | 短信服务（先补代码） | 上线阻断 | 1-3 天 | ¥0.04/条 | ❌ 代码是固定码 `888888` |
| B1 | 微信支付商户号 | 商业化 | 1-2 周 | 费率 0.6% | ❌ 只有 webhook 验签，下单 mock |
| B2 | 支付宝开放平台 | 商业化 | 1-2 周 | 费率 0.6% | ❌ 同上 |
| B3 | Stripe | 商业化 | 1-3 天 | 2.9%+$0.3 | ❌ 同上 |
| B4 | Apple IAP | 商业化 | 1 周 | $99/年 | ❌ 未实现（文档标注搁置） |
| B5 | Google Play Billing | 商业化 | 1 周 | $25 一次性 | ❌ 未实现 |
| C1 | Windows 代码签名证书 | 分发 | 1-3 周 | ¥1500-6000/年 | ❌ 完全未配置 |
| C2 | Tauri 更新签名密钥 + 更新服务 | 分发 | 半天 | 0 | ❌ pubkey = placeholder |
| C3 | Android keystore + Google Play | 分发 | 3-7 天 | $25 | ❌ release 用 debug 签名 |
| C4 | Apple Developer + iOS 证书 | 分发 | 3-7 天 | $99/年 | ❌ 无 Team、无证书 |
| C5 | **软件著作权** | 国内安卓 | **40-60 工作日** | ¥300-2000 | ❌ 未办（最大瓶颈） |
| C6 | **ICP 备案 → APP 备案**（先后关系，非同时） | 国内安卓 | 10-30 工作日 | 0 | ❌ 未办（流程见 `docs/audit/filing-guide-2026-09-09.md`） |
| C7 | 国内安卓商店账号（华为/小米/OPPO/vivo…） | 分发 | 各 1-3 天 | 免费 | ❌ 未注册 |
| C8 | 官网下载托管 + 缺失文件 | 分发 | 半天 | 0 | ❌ `download-links.ts` 文件缺失 |
| D1 | 对象存储（OSS/COS/S3 或自建 MinIO） | 增强 | 1 天 | 按量 | ⚠️ 代码有、依赖没装 |
| D2 | 飞书群机器人（告警） | 增强 | 5 分钟 | 免费 | ❌ `<FEISHU_WEBHOOK_URL>` 字面量 |
| D3 | Sentry 错误追踪 | 增强 | 1 小时 | 免费额度 | ❌ 未集成 |
| D4 | Grafana/监控（自托管） | 增强 | 自部署 | 0 | ⚠️ admin 密码硬编码 |
| D5 | CAPTCHA（人机验证） | 增强 | 1 天 | 免费 | ❌ 未实现 |
| D6 | OAuth 第三方登录 | 增强 | 各 1-3 天 | 免费 | ❌ 占位按钮 |
| D7 | FCM / APNs 推送 | 增强 | 3-5 天 | 0（需开发者账号） | ❌ 未集成 |
| D8 | 国内厂商推送（华/米/OP/vivo） | 增强 | 各 3-7 天 | 免费 | ❌ 未集成 |
| E1-E11 | **11 家 AI 供应商 Key** | **用户自带** | — | 用户自付 | ✅ 平台无需申请 |

> **E 类重要结论**：AI 供应商（OpenAI/Anthropic/DeepSeek/通义/混元/MiMo/MiniMax/阶跃/LongCat/Custom）的密钥**由你的终端用户在桌面端自己填**，加密存你的库里。**你运营 ClipSync 本身一家都不用申请**（除非你想自建默认供应商）。

---

## 1. 先修：申请前必须处理的 9 个"脏状态"

这些不修，申请了也配不进去 / 配进去也是假的安全感：

| # | 问题 | 证据 | 必须做什么 |
|---|---|---|---|
| 1 | **手机号验证码 = 888888，无环境判断** | `src/server/src/routes/auth-verify.js:55`、`auth.js:353` 注释 | 生产环境任何人输 888888 可登录任意手机号 → **先接短信网关（A4）再上线** |
| 2 | 域名四套不一致 | `k8s/base/ingress.yaml:20`(`api.clipsync.com`)、`k8s/base/ingress-networkpolicy.yaml:34`(`api.clipsync.app`)、`k8s/base/namespace-config-pvc.yaml:31`(`sync.clipsync.app`)、`docs/deploy/external-dependencies.md:18`(`clipstream.work`) | **先定根域**，全局替换 |
| 3 | `METRICS_TOKEN` 默认公开字符串 | `src/server/src/index.js:317` = `clipsync-metrics-dev-token` | 改成随机 32 位 |
| 4 | Grafana admin 密码硬编码 | `docker-compose.monitoring.yml:94` = `clipsync2024` | 改环境变量注入 |
| 5 | 更新包下载地址是 `example.com` | `src/server/src/routes/app.js:175` | 有托管后替换 |
| 6 | `update.json` 硬编码 `hasUpdate=false` | `src/server/src/routes/app.js:154-158` | 接版本表（AN-04） |
| 7 | S3 分支跑不起来 | `src/server/src/utils/storage.js:91` 动态 import，但 `@aws-sdk/client-s3` 不在 `src/server/package.json:25-43`；`initStorage()` 无调用点 | 装依赖或先不用 |
| 8 | 官网下载数据文件缺失 | `src/website/src/main.ts:25` import `./data/download-links`，该目录不存在 | 建文件（C8） |
| 9 | Android release 用 debug 签名 | `android/app/build.gradle.kts:37-39` | 生成 keystore（C3） |

---

## 2. A 类 · 上线阻断（先做这四项）

### A1 根域名 + DNS + 服务器

**现状**：`docs/deploy/external-dependencies.md:19` 明确标记"❌ 域名 DNS 配置"；k8s 与文档里出现 4 套域名（`.com` / `.app` / `clipstream.work` / `updates.clipsync.app`）。

**申请教程**
1. **定根域**（建议一步到位，后续所有配置都用它）：例如 `clipsync.app`。检查是否可注册：https://www.namesilo.com / https://wanwang.aliyun.com / https://dnspod.cloud.tencent.com
2. **注册**：实名认证（个人身份证 / 企业营业执照）→ 付款 → 域名到手
3. **DNS 解析**（以阿里云为例）：控制台 → 云解析 DNS → 添加记录：
   - `api` → A → 服务器公网 IP（后端）
   - `ws` → A → 同 IP（WebSocket）
   - `updates` → A → 同 IP（更新服务）
   - `app` → A 或 CNAME（官网）
4. **服务器**：一台 2C4G 起（Docker Compose 单机部署即可，`docker-compose.prod.yml`）

**产出**：域名 + 解析生效 + 服务器 IP
**填入位置**：
- `k8s/base/ingress.yaml:20-34`、`ingress-networkpolicy.yaml:34-48`（若走 K8s）
- `src/desktop/src-tauri/tauri.conf.json:53`（更新端点 `https://updates.你的域/api/app/update.json`）
- `docs/product/payment-integration-guide.md:73,139,190`（支付回调域名，需 HTTPS + 已备案）
**验证**：`nslookup api.你的域` 返回你的 IP；`curl https://api.你的域/api/health` 返回 healthy

> ⚠️ 若走国内服务器 + 国内支付/备案，**域名必须 ICP 备案**（见 C6）。

---

### A2 HTTPS 证书（Let's Encrypt）

**两种方式，二选一**

**方式一：服务器 + Nginx（单机，推荐先这样）**
```bash
# 安装 certbot
apt install -y certbot python3-certbot-nginx
# 签发（自动改 nginx 配置）
certbot --nginx -d api.你的域 -d ws.你的域 -d updates.你的域
# 自动续期（certbot 默认已加 systemd timer）
certbot renew --dry-run
```
证书落盘：`/etc/letsencrypt/live/api.你的域/fullchain.pem` 与 `privkey.pem`
填入：`nginx/conf.d/clipsync.conf` 的 `ssl_certificate` / `ssl_certificate_key`

**方式二：K8s + cert-manager**
```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.0/cert-manager.yaml
# 建 ClusterIssuer（名字要与代码一致：letsencrypt-prod）
```
证据：`k8s/base/ingress.yaml:15` 已写 `cert-manager.io/cluster-issuer: letsencrypt-prod`，`:22` `secretName: clipsync-tls`

**周期/费用**：免费 / 10 分钟
**验证**：`curl -I https://api.你的域/api/health` 返回 200 且证书有效；浏览器锁标无告警

---

### A3 SMTP 邮件服务（验证码 / 通知）

**现状**：`src/server/src/utils/email.js` 已完整实现；未配置时**静默 console 兜底不发信**（`:114-122`）——这是你"以为发了其实没发"的坑。凭据存 DB（`system_configs`），**在管理台填，不用改代码**。

**方案对比**

| 方案 | 地址 | 适用 | 成本 |
|---|---|---|---|
| QQ 邮箱（个人/测试） | mail.qq.com → 设置 → 账户 → 开启 POP3/SMTP → 生成**授权码** | 开发/小规模 | 免费，日发信有限 |
| 阿里企业邮 | qiye.aliyun.com | 正式（自有域名邮箱） | 按账号 |
| 阿里云邮件推送 | dm.console.aliyun.com | 生产群发 | 按量（前 200 封/日免费） |
| SendGrid | sendgrid.com | 海外 | 免费 100 封/日 |

**QQ 邮箱（最快，5 分钟）步骤**
1. 登录 https://mail.qq.com → 设置 → 账户
2. 找到「POP3/IMAP/SMTP/Exchange/CardDAV」→ 开启 **IMAP/SMTP服务**
3. 按提示用手机发短信 → 得到 **16 位授权码**（这就是 `smtp_pass`，不是邮箱密码）
4. 记录参数：`smtp.qq.com` / `465`（SSL）或 `587`（STARTTLS）

**填入位置（管理台，存库并加密）**
路径：后台 → 系统设置 → 邮件（SMTP）卡 → 逐项填 → 保存（**记得整个卡片点保存**）
对应后端：`src/server/src/routes/admin/configs.js:157-192`（CONFIG_CATALOG 的 smtp_* 六键）；`smtp_pass` 加密落库（`:340`）、读取脱敏（`:258-260`）
也可直接调 API：`PATCH /api/admin/configs/smtp_host` body `{ value }`

**验证**：管理台 → 系统设置 → 邮件卡 → **发送测试邮件** → 收件箱收到（未配置返回明确的 409/4090 错误壳，已实现）

---

### A4 短信服务（必须先补代码！）

**现状（严重）**：`src/server/src/routes/auth-verify.js:55` → `const code = '888888'; // MVP: fixed code`，**无 NODE_ENV 判断**；`utils/circuit-breaker.js:209-211` 定义了 sms 断路器但**零调用**。生产环境 = 短信验证码形同虚设。

**做之前**：先写代码接入（真发短信 + 随机验证码 + 有效期 + 防刷），再申请下面任一家。

**申请教程（阿里云短信，最常用）**
1. 注册/登录：https://dysms.console.aliyun.com
2. 开通「短信服务」
3. **申请签名**：控制台 → 国内消息 → 签名管理 → 添加签名
   - 签名来源选「APP/网站名」，填 **ClipSync**
   - 企业需上传营业执照；个人可选「自用/测试」
   - 审核 1-2 小时 ~ 1 天
4. **申请模板**：模板管理 → 添加模板
   - 模板类型「验证码」，内容如：`您的验证码是${code}，5分钟内有效。`
   - 审核同上
5. **拿 AccessKey**：右上角头像 → AccessKey 管理 → 创建 AccessKey（**AK/SK，勿进代码库**）
6. 记录：签名名称、模板 CODE、AccessKeyId、AccessKeySecret

**腾讯云同理**：https://console.cloud.tencent.com/smsv2（SDK AppID + 签名 + 模板）

**成本**：约 ¥0.04/条，套餐包更便宜
**需要新增的环境变量**（当前还没有，需你开发时加）：
`SMS_PROVIDER` / `SMS_ACCESS_KEY_ID` / `SMS_ACCESS_KEY_SECRET` / `SMS_SIGN_NAME` / `SMS_TEMPLATE_CODE`
**验证**：调 `POST /api/auth/send-code` → 手机真收到随机 6 位码；输错码不通过（不再是 888888 万能码）

---

## 3. B 类 · 商业化（支付）

> **共同前提**：微信/支付宝**必须有企业营业执照 + 对公账户**（个人无法申请）。这是整份清单里最耗时的一段，建议最早启动。

### B1 微信支付

**现状**：`src/server/src/middleware/webhook-signature.js:39-119`（APIv3 验签已实现，手写 crypto）；`routes/payments.js:131-149` 下单返回 `mock:true` + `/payment/mock?orderNo=`。**回调是真的，下单是假的**。

**申请步骤**
1. 微信支付商户平台：https://pay.weixin.qq.com → 成为商户 → 接入指引
2. 提交：**营业执照、法人身份证、对公银行账户、经营场景照片、公众号/小程序 AppID**（需先在 https://open.weixin.qq.com 注册开放平台账号并创建应用）
3. 审核：1-3 个工作日；审核通过后**超级管理员在「账户中心 → API安全」设置 APIv3 密钥**
4. 下载**平台证书**（也是 API安全页，用于验签）：PEM 内容
5. 配置支付回调地址：`https://api.你的域/api/webhooks/wechat-pay`（代码 `routes/payments.js:199-236`）

**产出 & 填入**
| 凭据 | 环境变量 | 证据 |
|---|---|---|
| APIv3 密钥 | `WECHAT_PAY_APIV3_KEY` | `webhook-signature.js:264-267` |
| 商户号 | `WECHAT_PAY_MCH_ID` | 同上 |
| 平台证书 PEM | `WECHAT_PAY_PLATFORM_CERT` | `:75`（缺 → 500 `Platform certificate not configured`） |

> ⚠️ **命名坑**：文档写的是 `WXPAY_*`、`ALIPAY_PUBLIC_KEY_PATH`（文件路径），**代码实际读 `WECHAT_PAY_*` 和 `ALIPAY_PUBLIC_KEY`（PEM 内容）**——以代码为准。

**验证**：后端日志出现验签通过；`GET /api/admin/orders` 出现真实渠道订单；管理台「对账报告」有数据

---

### B2 支付宝

**申请步骤**
1. 支付宝开放平台：https://open.alipay.com → 注册企业账号 → 实名认证（营业执照 + 对公账户）
2. 控制台 → 创建**网页/移动应用** → 获得 `APPID`
3. 应用详情 → **接口加签方式** → 设置：
   - 用工具 https://opendocs.alipay.com/common/02kipk 生成 **应用公私钥（RSA2 2048）**
   - 上传应用公钥 → 支付宝返回 **支付宝公钥**
4. 产品中心签约 **手机网站支付 / 电脑网站支付**（需审核，1-3 天）
5. 配置异步通知：`https://api.你的域/api/webhooks/alipay`

**产出 & 填入**
| 凭据 | 环境变量 | 证据 |
|---|---|---|
| 支付宝公钥（PEM 内容） | `ALIPAY_PUBLIC_KEY` | `webhook-signature.js:275-278` |
| 应用私钥 | 你的代码内使用（当前未实现） | — |

**验证**：同 B1

---

### B3 Stripe（海外收款，最简单）

**申请步骤**
1. 注册：https://dashboard.stripe.com/register
2. 激活账号：邮箱验证 → 填写**企业信息 + 银行账户**（个人也可注册，功能受限）
3. 测试模式先跑通：Dashboard → Developers → API keys → 复制 **Secret key**（`sk_test_...`）
4. Webhook：Developers → Webhooks → Add endpoint
   - URL：`https://api.你的域/api/webhooks/stripe`
   - 事件至少选：`checkout.session.completed`、`customer.subscription.*`、`invoice.payment_*`
   - 创建后拿到 **Signing secret**（`whsec_...`）
5. 产品与价格：Products → 建 Pro/Enterprise 两个价格 → 记录 **Price ID**（文档提到 `STRIPE_PRICE_ID_PRO/ENTERPRISE`，代码目前零引用）

**产出 & 填入**
`STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`（`webhook-signature.js:284` / `payments.js:288`）
> ⚠️ `payments.js:288` 有 `'mock_secret'` 兜底——**上线前必须删**，否则验签形同虚设。

**验证**：Stripe Dashboard → Webhooks → 看事件投递成功（返回 200）

---

### B4 / B5 移动端内购（IAP）

- **Apple IAP**：https://developer.apple.com（$99/年）→ App Store Connect 建 App → 「App 内购买项目」建订阅 → 税务/银行协议（`docs/product/payment-integration-guide.md:229-260`，文档标注"已搁置"）
- **Google Play Billing**：https://play.google.com/console（$25 一次性）→ 建应用 → 「商品 → 订阅」（`guide:263-285`）
- **代码现状**：`src/mobile/pubspec.yaml:9-52` **无 `in_app_purchase` 依赖**，服务端零代码 → 属于"先有账号再开发"

---

## 4. C 类 · 分发与签名（桌面端 + 移动端）

### C1 Windows 代码签名证书

**现状**：`src/desktop/src-tauri/tauri.conf.json:33-48` bundle 只有 `targets:["nsis"]`，全仓搜 `certificateThumbprint / signCommand / timestampUrl` **0 命中** → 未签名。未签名的 exe 会被 SmartScreen 拦、被杀软误报。

**购买**（任选一家 CA，国内可走代理）
- DigiCert：https://www.digicert.com
- Sectigo：https://sectigo.com
- GlobalSign：https://www.globalsign.com
- 国内代理（沃通等）：https://www.wosign.com

**类型选择**
| 类型 | 价格 | 特点 |
|---|---|---|
| **OV** | ¥1500-4000/年 | 组织验证，需累积 SmartScreen 信誉（前几百次下载会告警） |
| **EV** | ¥2000-6000/年 | 扩展验证，**立即建立信誉**，需 USB Key 硬件 |

**材料**：营业执照、邓白氏编码（部分 CA 需要）、法人授权书、电话验证
**周期**：OV 3-10 天，EV 1-3 周
**产出**：证书文件（`.pfx`）+ 私钥密码
**填入位置**：`src/desktop/src-tauri/tauri.conf.json` 的 `bundle.windows` 增加：
```json
"certificateThumbprint": "<证书指纹>",
"digestAlgorithm": "sha256",
"timestampUrl": "http://timestamp.digicert.com"
```
**验证**：右键 exe → 属性 → 数字签名 → 显示"此数字签名正常"

---

### C2 Tauri 更新：签名密钥 + 更新服务（半天搞定）

**现状**：`tauri.conf.json:54` pubkey = `"placeholder_pubkey_replace_in_production"`，Rust 层 `src-tauri/src/lib.rs:1072-1074` **主动拦截**该值并返回 `UPDATER_NOT_CONFIGURED`；服务端 `routes/app.js:154-158` 硬编码 `hasUpdate=false`、下载链接是 `https://example.com/...`（`:175`）。

**步骤**
1. **生成密钥对**（本机执行一次即可）
```bash
cd src/desktop
npx tauri signer generate -- -w ~/.tauri/clipsync.key
# 输出：私钥内容（TAURI_SIGNING_PRIVATE_KEY）+ 公钥（pubkey）
```
2. **公钥** → 填入 `src/desktop/src-tauri/tauri.conf.json:54` 的 `pubkey`
3. **私钥** → 打包机器的环境变量 `TAURI_SIGNING_PRIVATE_KEY`（**全仓当前 0 命中，尚未配置**）
4. **更新服务**：确保 `https://updates.你的域/api/app/update.json` 可达（服务端 `routes/app.js:152-179` 已有该路由，需把版本号/下载链接改为真实值——见 AN-04 工单）
5. **安装包托管**：上传 exe 到对象存储/服务器 → 替换 `app.js:175` 的 `example.com` 链接

**验证**：桌面端 设置 → 关于 → 检查更新 → 能查到新版本并下载安装（不再提示"更新服务未配置"）

---

### C3 Android 签名 + Google Play

**现状**：`android/app/build.gradle.kts:37-39` → `// TODO: Add your own signing config` + `signingConfig = signingConfigs.getByName("debug")`；全仓无 `.jks` / `key.properties`。**release 用 debug 签名绝不能上架**。

**生成 keystore（一次，永久保存）**
```bash
keytool -genkey -v -keystore clipsync-keystore.jks -alias clipsync \
  -keyalg RSA -keysize 2048 -validity 10000
# 记下：keystore 密码、key 别名、key 密码
```
（命令出处：`docs/product/domestic-android-publish-guide.md:88`）

**配置**：建 `android/key.properties`（**加入 .gitignore，绝不入库**）
```properties
storeFile=../clipsync-keystore.jks
storePassword=***
keyAlias=clipsync
keyPassword=***
```
`build.gradle.kts` 读取该文件并替换 `signingConfig`（`:37-39`）

**Google Play 上架**
1. https://play.google.com/console/signup → 缴 **$25 一次性**
2. 完成身份/开发者资料验证（2023 起个人开发者也需测试者要求）
3. 创建应用 → 上传 **AAB**（`build.gradle.kts:53-64` 已配置 bundle split）
4. 填：应用名称、描述、截图、隐私政策 URL、数据安全表、分级问卷
5. 「应用签名」建议加入 Google Play 应用签名（由 Google 托管密钥）

**⚠️ 上架材料（Android 全渠道都要）**
- **隐私政策页**（必须公开 URL）
- **权限用途说明**——尤其本项目用了**无障碍服务**（`AndroidManifest.xml:89-110`）与通知监听，商店审核重点，必须逐条说明
- `usesCleartextTraffic="true"`（`:28`）上线前应改为 HTTPS 白名单

---

### C4 Apple Developer + iOS 证书

**现状**：`ios/Runner.xcodeproj/project.pbxproj:397` `CODE_SIGN_STYLE = Automatic`，但**无 DEVELOPMENT_TEAM**；无 `.p12` / `.mobileprovision`。Bundle ID `com.clipsync.clipsyncMobile`，与 Android `com.clipsync.clipsync_mobile` 不一致 → **先统一**。

**步骤**
1. 加入 Apple Developer Program：https://developer.apple.com/programs/ → **$99/年**（企业需邓白氏编码，审核 1-3 天）
2. https://developer.apple.com/account → Certificates → 创建 **Apple Distribution** 证书（用 Mac 钥匙串生成 CSR）→ 下载 `.cer` → 双击导入 → 导出 `.p12`
3. Identifiers → 注册 App ID（`com.clipsync.mobile` 统一后）→ 勾选 Push Notifications（将来）
4. Devices → 加测试机 UDID（Ad Hoc/开发用）
5. Profiles → 创建 **App Store** 与 **Ad Hoc** Provisioning Profile → 下载双击
6. Xcode：Runner → Signing & Capabilities → 取消 Automatic → 选 Team 与对应 Profile
7. App Store Connect：https://appstoreconnect.apple.com → 新建 App → 填资料、截图、隐私政策 → TestFlight 提测 → 提交审核

---

### C5 软件著作权 + C6 备案（**国内安卓最大瓶颈，最早启动**）

| 事项 | 入口 | 周期 | 费用 |
|---|---|---|---|
| **软件著作权** | 中国版权保护中心 https://www.ccopyright.com.cn（或各省代办处） | **40-60 工作日**（加急 5-15 工作日，另付费） | 官方 ¥0（代办 ¥300-2000） |
| **APP 备案** | 工信部 https://beian.miit.gov.cn（由接入商代为提交） | 3-7 工作日 | 免费 |
| **ICP 备案** | 同上（域名备案） | 7-20 工作日 | 免费 |
| **ICP 许可证**（仅当你线上收费） | 省通信管理局 | 30-60 工作日 | 代办费不等 |

**软著材料**：源代码（前后各 30 页，每页 50 行）、操作说明书、申请人身份证明、申请表
**关键**：软著是华为/小米/OPPO/vivo/应用宝**上架的硬门槛**，2-3 个月周期 → **现在就启动**

---

### C7 国内安卓商店（账号全免费，但材料要齐）

| 商店 | 入口 | 备注 |
|---|---|---|
| 华为 | https://developer.huawei.com/consumer/cn/ | 需软著 + 备案 |
| 小米 | https://dev.mi.com | 同上 |
| OPPO | https://open.oppo.com | 同上 |
| vivo | https://dev.vivo.com.cn | 同上 |
| 应用宝 | https://open.tencent.com | 同上 |
| 百度 | https://app.baidu.com | — |
| 360 | https://dev.360.cn | — |

（入口出处：`docs/product/domestic-android-publish-guide.md:243-249`）
**材料**：营业执照、软著、APP 备案号、APK（加盖商店签名）、图标（各尺寸）、截图、隐私政策、权限说明

---

### C8 官网下载托管（+ 修一个缺失文件）

**现状（会构建失败）**：`src/website/src/main.ts:25` `import { DOWNLOAD_LINKS } from './data/download-links'`，但 `src/website/src/data/` **目录不存在**；`index.html:207-227` 有 4 张下载卡。

**做法**
1. 选托管：**GitHub Releases**（免费，最简单）或 对象存储 CDN
2. 建 `src/website/src/data/download-links.ts`：
```ts
export const DOWNLOAD_LINKS = {
  windows: 'https://github.com/CarlosShao/ClipSync/releases/latest/download/xxx.exe',
  macos: '',   // 暂无
  linux: '',   // 暂无
  android: '', // 商店链接
}
```
3. 官网卡片补上链接（`index.html:215-227`）

---

## 5. D 类 · 增强与可选

### D1 对象存储（阿里云 OSS / 腾讯 COS / AWS S3 / 自建 MinIO）

**现状**：`src/server/src/utils/storage.js:110-199` 有实现，但 `@aws-sdk/client-s3` **不在** `src/server/package.json:25-43`，且 `initStorage()` 无调用 → 现在设 `STORAGE_TYPE=s3` 会崩。默认 `local`（`:15`）。

**阿里云 OSS**
1. https://oss.console.aliyun.com → 开通 → 创建 Bucket（读写权限：**私有**，用签名 URL）
2. 拿 **AccessKey**（同 A4 的 RAM，建议新建子账号只给 OSS 权限）
3. 记下：`Endpoint`（如 `oss-cn-hangzhou.aliyuncs.com`）、`Region`、`Bucket`

**填入**（环境变量）
`STORAGE_TYPE=s3`、`S3_BUCKET`、`S3_REGION=oss-cn-hangzhou`、`S3_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`
（代码位置：`storage.js:93-97`）
**前置**：先 `npm i @aws-sdk/client-s3` 并接上 `initStorage()` 调用点

---

### D2 飞书群机器人（告警，5 分钟）

**现状**：`docker-compose.monitoring.yml:63` 值是字面量 `"<FEISHU_WEBHOOK_URL>"`

**步骤**
1. 飞书群 → 设置 → 群机器人 → 添加机器人 → **自定义机器人**
2. 复制 Webhook 地址（可设签名校验 → 得到 `FEISHU_SECRET`）
3. 填入：`docker-compose.monitoring.yml:63`（或写入 `.env` 后引用变量）
4. 重启监控栈：`docker compose -f docker-compose.monitoring.yml up -d`

**验证**：`docker logs alertmanager` 无报错；手动触发一次告警（如停掉 api 容器 30s）→ 群里收到卡片

---

### D3 Sentry

1. https://sentry.io → 注册（免费额度每月 5k 错误事件）
2. Create Project → 平台选 Node.js → 得到 **DSN**
3. 目前**代码未集成**（`src/server/src` 无 sentry 依赖）→ 需开发接入后填 `SENTRY_DSN`（`src/server/.env.example:96` 已预留变量名）

---

### D4 监控栈（自托管，无需账号）

Prometheus / Grafana / Alertmanager / Blackbox / Node-Exporter 全部 Docker Hub 公开镜像（`docker-compose.monitoring.yml:6-128`）
**唯一要改**：`docker-compose.monitoring.yml:94` Grafana admin 密码 `clipsync2024` → 改环境变量注入

---

### D5 CAPTCHA / D6 OAuth / D7-D8 推送

| 项 | 现状 | 申请入口 |
|---|---|---|
| CAPTCHA | 未实现 | reCAPTCHA https://www.google.com/recaptcha/admin；Cloudflare Turnstile（免费）；腾讯云验证码 https://console.cloud.tencent.com/captcha |
| OAuth 登录 | 占位按钮（`AuthPage.vue:759,986` 点出"敬请期待"） | 微信 open.weixin.qq.com / Apple developer.apple.com / GitHub https://github.com/settings/developers（**都需要已备案 HTTPS 回调域名**） |
| FCM | 未集成（无 `google-services.json`） | https://console.firebase.google.com |
| APNs | 未集成（无 entitlements） | Apple Developer（见 C4） |
| 厂商推送 | 未集成 | 华为/小米/OPPO/vivo 开发者后台（同 C7 账号） |

---

## 6. E 类 · AI 供应商（**你不用申请，但要知道用户会填什么**）

预设表：`src/server/src/utils/aiProviders.js:109-220`；用户 Key 加密入库（`routes/aiProviders.js:141-143`）；**服务端代码内没有任何 AI 平台密钥**。

| 供应商 | 申请入口 | 备注 |
|---|---|---|
| OpenAI | https://platform.openai.com/api-keys | 需绑卡 |
| Anthropic | https://console.anthropic.com | |
| DeepSeek | https://platform.deepseek.com | 便宜，推荐做默认推荐 |
| 通义千问 | https://dashscope.console.aliyun.com | 阿里云账号 + 开通 DashScope |
| 腾讯混元 | https://cloud.tencent.com/product/hunyuan | |
| 小米 MiMo | https://api.xiaomimimo.com | 认证头是 `api-key`（无 Bearer） |
| MiniMax | https://platform.minimaxi.com | |
| 阶跃星辰 | https://platform.stepfun.com | Explore 通道**申请制**（`aiProviders.js:189`） |
| 美团 LongCat | https://api.longcat.chat | |
| Custom | 任意 OpenAI/Anthropic/Responses 兼容端点 | ⚠️ **SSRF 防护**（`aiProviders.js:52-80`）禁 localhost/私网，自建 Ollama 必须挂公网域名 |

---

## 7. 建议执行顺序（照着走）

```
第 0 周（立即，不花钱）：
  ├ 定根域（全局替换 4 套域名）           A1
  ├ 生成 Tauri 更新签名密钥 + 配置         C2
  └ 提交软件著作权申请（周期最长！）        C5

第 1 周（上线前）：
  ├ 服务器 + 域名解析 + Let's Encrypt     A1/A2
  ├ SMTP（QQ 邮箱授权码先顶上）            A3
  ├ 飞书机器人告警                        D2
  └ 改掉 5 个硬编码默认值（第 1 节表格）    —

第 2-4 周（商业化，最慢，最早启动材料）：
  ├ 微信支付 / 支付宝（企业资质审核）       B1/B2
  └ Stripe（海外，最快）                   B3

第 1-2 月（分发）：
  ├ Windows 代码签名证书                  C1
  ├ Android keystore + Google Play        C3
  ├ Apple Developer + iOS 证书            C4
  ├ ICP/APP 备案 + 国内商店                C6/C7
  └ 官网下载托管 + 补缺失文件              C8

按需：
  ├ 短信服务（需先开发）                   A4
  ├ 对象存储                              D1
  ├ Sentry / CAPTCHA / OAuth / 推送        D3-D8
```

---

## 8. 申请完成后，记得做这三件事

1. **凭据一律走环境变量 / 管理台配置，绝不进 Git**。提交前检查：`.env`、`*.jks`、`*.p12`、`key.properties`、`google-services.json` 必须在 `.gitignore`
2. **同步更新**（避免又变成文档与代码不一致）：
   - `src/server/.env.example`（变量名与说明）
   - 本文「状态」列
   - `docs/deploy/external-dependencies.md`
3. **逐项验证**，每接一个就跑一次：`node scripts/admin-full-audit/run-audit.mjs all` + 后台管理台对应页面实际点一次（能保存、能发信、能收到回调）
