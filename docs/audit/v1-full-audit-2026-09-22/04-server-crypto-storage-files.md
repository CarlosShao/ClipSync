# 加密体系 / 文件存储 / 上传下载 / 分享链接 审计

- 审计日期：2026-09-22
- 范围：`src/server/src/{crypto,routes/{storage,media,chunked-upload,sharedLinks,protection,favorites,clipboard},services/fileRetentionCleanup.js,utils/{encryption,protectionCrypto,storage,imageHash,aiOcr}.js}`、DB schema、配置与 compose、桌面（Rust/TS）与移动（Dart）加密实现、相关测试与需求文档
- 纪律：只读审计，未修改任何源码；未运行测试/服务/docker。

## 结论（≤3 句）

E2E 加密的密码学实现本身是正确且跨端一致的（Rust/Dart 对同一测试向量对拍通过，IV 全部每消息随机、无复用、无废弃 API），但 **README 与用户手册无条件宣称的「端到端加密」不成立**：E2E 是双端默认关闭的可选项，关闭时（默认态）全部文本/图片以明文存储在 `content_encrypted` 列与磁盘，且「高级密码保护」会把密码和明文正文一起上传服务端。此外发现 2 个 S0 级路径穿越（分享链接 `fileKey` 可任意目录读取并对外发布、其撤销接口可 `rm -rf` 服务器上任意可读目录，容器以 root 运行）以及分块上传 multer 文件名穿越等多个 S1。文件删除三条路径（条目删除/过期清理/GDPR 删号）均不清理磁盘文件，备份脚本只备 DB。

## E2E 加密成立性判定

**判定：部分成立（按宣传口径不成立）。**

成立的部分（证据链）：
1. 协议契约明确：ECDH P-256 + HKDF-SHA256(salt=`clipsync-e2e-v1`, info=deviceId) + AES-256-GCM，密文格式 `base64(ciphertext||tag16)`（`docs/plans/e2e-protocol.md:8-37`）。
2. 私钥只在端侧生成与保存：桌面 Rust 写 `app_data_dir/e2e-key.pem`（0600，`src/desktop/src-tauri/src/e2e_crypto.rs:14-25,227-262`），移动端写 `flutter_secure_storage`（`src/mobile/lib/services/e2e_crypto.dart:35-40`）。服务端只存公钥并做信封结构校验（`src/server/src/routes/clipboard.js:573-601`），**全仓无任何服务端持有的 E2E 主密钥**，服务端无法解密 E2E 条目。
3. 每条内容随机 K(32B)+IV(12B)+一次性临时 ECDH 对（`e2e_crypto.rs:319-341`、`e2e_crypto.dart:325-340`），无 IV 复用；GCM tag 校验失败即整体失败（`e2e_crypto.rs:139-144`）。
4. 跨端互操作有真实向量测试：`docs/plans/e2e-vector.json` 被 Rust（`e2e_crypto.rs:522-567`）与 Dart（`src/mobile/test/e2e_crypto_test.dart:5,22`）硬编码对拍。
5. E2E 条目服务端明文功能全部降级：OCR 双保险跳过（`src/server/src/utils/aiOcr.js:143-151`）、图片查重跳过（`clipboard.js:610-611`）、text-preview 409（`media.js:994-1001`）。

不成立的部分（落差证据链）：
1. **宣称是无条件的**：`README.md:11`「**端到端加密**：隐私数据不经过服务器明文传输」；`docs/product/user-guide.md:631-637`「即使是 ClipSync 的开发者也无法查看您的明文数据」。
2. **E2E 双端默认关闭**：协议 §5 明文「用户级设置开关……默认关闭」（`e2e-protocol.md:65`）；桌面 `e2eCrypto.ts:42-48`（localStorage 无值即 false）、移动 `settings_provider.dart:34-38`（`_e2eEnabled = false`）。
3. **默认态 = 全明文入库**：桌面上传 `content: e2e ? e2e.contentEncrypted : content`（`clipboardUpload.ts:400-401`）；服务端原样写入 `content_encrypted` 列（`clipboard.js:689-693`）；`content_preview` 存前 5000 字符明文并建 ILIKE/tsvector 索引（`clipboard.js:98,568`）；迁移注释直接承认「历史命名、实际为明文」（`src/mobile/lib/services/api_service.dart:192-193`、`db/migrations/016_expand_text_preview.sql:15`）。
4. **图片/文件（multipart 路径）任何情况下都是服务端明文**：`POST /api/media/image`、`POST /api/media/file` 原始字节直接落盘、`content_encrypted` 存文件名（`media.js:170-171,184-190,404-414`），无 E2E 分支；桌面图片以明文 dataURL 入库（`clipboardUpload.ts:491,505`）。仅 chunked 路径在开关开启时上传密文字节。
5. **开启后仍有明文降级**：>64MB 文件自动回退明文上传（`e2eCrypto.ts:37`、`clipboardUpload.ts:852-870` 仅 toast 提示）；无收件人公钥时 `encryptBytes` 返回 null 回退明文（`e2eCrypto.ts:130-133`）。
6. **「高级密码保护」与 E2E 叙事直接矛盾**：`POST /api/protection/setup` 要求客户端上传明文密码 + 明文正文，服务端执行 DEK 包装（`protection.js:33,75-82`；桌面 `useProtection.ts:65-105` 实际调用），服务端瞬间持有明文并可随时用库中 wrapped DEK + salt 重演解密；`/unlock` 直接把解密后的明文经 API 返回（`protection.js:176-187`）。

**结论**：对「开关开启 + 文本/图片(clipboard 路径)/≤64MB 文件(chunked 路径)」的条目，E2E 在密码学上成立；对产品对外宣称的默认全量场景，**不成立**。属 S0 产品诚信问题（见问题清单 #1）。

## 跨端加密参数一致性核对表

| 参数 | 桌面 Rust (`e2e_crypto.rs`) | 桌面 TS (`e2eCrypto.ts` / `useItemPassword.ts`) | 移动 Dart (`e2e_crypto.dart`) | 服务端 |
|---|---|---|---|---|
| E2E 算法栈 | ECDH P-256 + HKDF-SHA256 + AES-256-GCM | 无自有实现（invoke 封装 Rust，:67-85） | 同 Rust（pointycastle ECDH + cryptography AES-GCM/HKDF） | 不实现（仅结构校验 `clipboard.js:573-601`） |
| HKDF salt / info | `clipsync-e2e-v1` / deviceId（:48,152-154） | — | `clipsync-e2e-v1` / deviceId（:71,241-245） | — |
| 内容密钥 / IV | 随机 32B K + 12B IV，每条新临时 ECDH 对（:319-324） | — | 同（:325-330） | — |
| 密文拼接 | `base64(ct‖tag16)` 进 `content_encrypted`；信封 `{v,alg,epk,iv,keys{w,iv}}` 进 `metadata.e2e`（:343-350） | 同（拆列逻辑 :137-144） | 同（:342-349） | 原样透传 |
| 编码 | base64 STANDARD（:114-122） | btoa/atob | base64.encode/decode | base64 长度校验 |
| 向量对拍 | ✅ cargo test（:539-597） | —（经 Rust） | ✅ flutter test（`test/e2e_crypto_test.dart`） | ❌ 无（tests/crypto.test.js 测的是死代码 keyExchange） |
| 条目密码 KDF | — | 死代码：PBKDF2-**SHA-256** 100k + 16B salt，格式 `v1:salt:iv:ct`（`useItemPassword.ts:10-13,58-66`；`ItemPasswordDialog.vue` 无引用） | 无客户端实现（走服务端 unlock） | PBKDF2-**SHA-512** 100k + 16B salt，DEK 双包装 `iv:tag:ct` base64（`protectionCrypto.js:15-16,41-44`） |
| 服务端 at-rest 加密 | — | — | — | AES-256-GCM，`ENCRYPTION_KEY`(env) 补零/截断至 32B，格式 `iv:authTag:ct` **hex**（`utils/encryption.js:55-71,86-107`），仅用于 shared_links 正文与 AI key，不用于 clipboard_items |

结论：**E2E 信封三端逐字一致且有向量测试**（不会发生「手机加密电脑解不开」）；不一致点集中在条目密码双轨制——桌面存在一套未接线的纯前端方案（SHA-256、`v1:` 格式），与服务端/移动端在用的方案（SHA-512、DEK 格式）互不兼容，一旦被启用即产生跨端解不开的数据（见 S3 #17）。

## 问题清单（按严重度从高到低）

### [S0] 1. 「端到端加密」宣传与默认实现不符（产品诚信）

- 证据：`README.md:11`「**端到端加密**：隐私数据不经过服务器明文传输」；`docs/product/user-guide.md:633-635`「即使是 ClipSync 的开发者也无法查看您的明文数据」；但 E2E 默认关闭（`e2e-protocol.md:65`、`e2eCrypto.ts:44`、`settings_provider.dart:38`），默认路径明文入库（`clipboardUpload.ts:400-401`、`clipboard.js:689-693`、`api_service.dart:193`「实际为明文」），media multipart 路径永远明文（`media.js:170-171,404-414`），且服务端持有明文预览/OCR 全文（`clipboard.js:568`、`aiOcr.js:159-163`）。
- 失败场景：任何用户按 README 宣传使用产品（不做任何设置），复制的密码/身份证号以明文存储在服务商 DB（`content_encrypted` 列 + `content_preview` 前 5000 字符 + `ocr_text`），运维/入侵者拖库即得全量明文；监管或用户按宣传文案追责即构成虚假宣传。
- 影响：产品诚信（致命）+ 数据安全；付费产品上线后被发现将直接摧毁信任，且有合规风险。
- 修法：二选一——(a) E2E 改为默认开启、关闭需显式确认，宣传文案限定为「开启 E2E 后」并如实披露默认态与降级面（>64MB 文件、multipart 图片路径）；(b) 立即修改 README/用户手册为准确表述。

### [S0] 2. sharedLinks `fileKey` 路径穿越：任意目录文件对外发布 + 公开下载

- 证据：`src/server/src/routes/sharedLinks.js:196-201`
  ```js
  const candidateDir = path.join(SHARED_UPLOAD_BASE, fileKey);
  const entries = await fs.readdir(candidateDir).catch(() => []);
  ...
  filePath = path.join(candidateDir, entries[0]);
  ```
  `fileKey` 来自请求体、未做任何校验（无 UUID 校验、无 basename、无 containment 检查）；`filePath` 落库后由公开接口 `GET /public/:token/download` 无鉴权 `res.sendFile(path.resolve(r.file_path))`（:399）吐出。
- 失败场景：任意登录用户 `POST /api/shared-links {contentType:'file', fileKey:'../../../src/server/src/config'}` → 服务端 readdir 该目录并把第一个文件写入 `shared_links.file_path` → 攻击者拿到公开 token URL，未登录即可下载该文件。反复对不同目录创建分享可逐目录抽取服务器任意可读文件（配置、源码、其他用户的 `uploads/files/*`、`uploads/images/*`）。
- 影响：安全（任意文件读取 + 跨用户数据外泄）；E2E 宣称同时被击穿（密文文件被拖走虽不可解，但明文文件直接可读）。
- 修法：`fileKey` 强制 UUID 校验 + `path.resolve` 后校验必须位于 `SHARED_UPLOAD_BASE` 前缀内；更根本地，把 upload-file 返回的 fileKey 落库绑定上传者，创建分享时校验归属。

### [S0] 3. sharedLinks 撤销接口对穿越产生的 `file_path` 做 `fs.rm(dirname, recursive)`：任意目录递归删除

- 证据：`sharedLinks.js:290-298`
  ```js
  if (r.file_path) {
    const dir = path.dirname(r.file_path);
    await fs.rm(dir, { recursive: true, force: true });
  }
  ```
  `file_path` 由问题 #2 的穿越完全受控；容器无 `USER` 指令、以 root 运行（`src/server/Dockerfile` 全文无 USER）。
- 失败场景：攻击者 `POST /api/shared-links {contentType:'file', fileKey:'../../images'}` → `file_path = uploads/images/<某文件>` → `DELETE /api/shared-links/:id` → `fs.rm('uploads/images', {recursive:true})` 把**所有用户**的全部上传图片连缩略图删光；把 fileKey 换成 `../../../..` 可指向 `/app` 级目录直接摧毁应用（root 权限下无路径不可达）。
- 影响：数据（不可恢复的用户文件批量销毁）+ 可用性；命中审计基线「误删用户文件 = S0」。
- 修法：删除前校验 `dirname(file_path)` 必须等于 `SHARED_UPLOAD_BASE/<uuid>` 形态（与 #2 一起修：file_path 只允许指向 shared 目录下 UUID 子目录）。

### [S1] 4. chunked-upload：multer 文件名直接拼接未校验的 URL 参数（Express 5 会解码 %2F）→ 任意路径写文件

- 证据：`src/server/src/routes/chunked-upload.js:155-161`
  ```js
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, MULTER_TMP),
    filename: (req, file, cb) => {
      const { uploadId, chunkIndex } = req.params;
      cb(null, `${uploadId}_${chunkIndex}`);
    },
  });
  ```
  `upload.single('chunk')` 在会话/参数校验之前执行（:259）。本仓 Express 5.2.1 下实测（本地只读脚本）：`POST /chunk/abc/..%2F..%2Fevil` → `req.params.chunkIndex === '../../evil'`，即 `..%2F` 会被解码进参数。
- 失败场景：已登录用户 `POST /api/upload/chunk/..%2F..%2F..%2F..%2Fapp%2Fsrc%2Fevil/0` 携带任意 chunk 内容 → multer 把攻击者内容写到 `/app/src/evil_0`（root 容器内任意可写路径）。缓解：handler 随后 404 且 `finally` 会 `fs.unlink(req.file.path)`（:347-351），文件仅在请求处理窗口内存在；但 Redis 慢/挂时窗口拉长，unlink 失败（`catch(() => {})` 吞错）时文件持久残留，并发多请求可制造稳定竞争窗口用于替换运行时代码文件。
- 影响：安全（临时任意文件写 → 竞争条件下可升级为 RCE）；即使被 finally 清理，也属必须在上线前消除的穿越原语。
- 修法：multer filename 只用服务端生成的 uuid；或在 filename 回调前强制 `/^[0-9a-f-]{36}$/`（uploadId）+ `/^\d+$/`（chunkIndex）校验并 `path.basename` 兜底。

### [S1] 5. 生产验证码使用 `Math.random`（可预测 PRNG）

- 证据：`src/server/src/routes/auth-verify.js:120-122`
  ```js
  const code = process.env.NODE_ENV === 'production'
    ? Math.floor(100000 + Math.random() * 900000).toString()
    : '888888';
  ```
  邮箱验证码同款（`auth-verify.js:394-396`）；短信侧 `utils/sms.js:96` 也是 `Math.random`，注释自认「不引入 crypto 依赖」。
- 失败场景：V8 的 `Math.random` 是 xorshift128+，攻击者收集同一进程先前若干次输出（如自己账号触发的验证码回显/时序侧信道）即可恢复内部状态、预测他人验证码 → 手机号/邮箱登录接管任意账号。
- 影响：安全（账号接管）；命中审计要求「随机数必须 crypto.randomBytes」。
- 修法：全部改 `crypto.randomInt(100000, 1000000)`。

### [S1] 6. GDPR 删号只删 DB、不删磁盘文件；响应却宣称「permanently deleted」

- 证据：`src/server/src/routes/auth.js:1420-1429`（仅 `DELETE FROM users`，注释列出的级联全是 DB 表）、`:1441`「Account has been permanently deleted」；无任何对 `uploads/images|files|shared` 的清理调用（全文件无 fs 引用）。
- 失败场景：用户行使被遗忘权删号后，其全部上传图片、同步文件、分享文件仍完整保留在服务器磁盘且无任何后续任务会清理（fileRetentionCleanup 只处理 DB 中仍存在的条目）；监管核查或用户取证即发现「删除」是假的。
- 影响：合规（GDPR/个保法）+ 产品诚信 + 磁盘泄漏。
- 修法：删号事务内先按用户条目清单调用 `deleteStoredClipFiles` + 清 shared/uploads 归属文件，再删 DB；失败进重试队列。

### [S1] 7. 「高级密码保护」= 密码 + 明文正文上传服务端，服务端可解密，且与 E2E 叙事冲突

- 证据：`src/server/src/routes/protection.js:33`（body 取 `password`）、`:73-82`
  ```js
  // Note: In production, this should come from the client, not the database
  // For now, we'll assume the client sends the plaintext
  const { content } = req.body;
  ...
  const protectionData = setupAdvancedProtection(content, password);
  ```
  桌面实际调用链：`ProtectionDialog.vue:128-135` → `useProtection.ts:85-88`（`body.password = password; body.content = content`）；移动端解锁同样上传密码（`item_actions_api_service.dart:149-153`）。代码注释自认是临时方案。
- 失败场景：用户对敏感条目设「高级加密」后以为只有自己能解；实际上服务端在 setup/unlock/rotate 时反复拿到明文密码与明文正文（进程内存、可能的 APM/日志面），且 DB 中 `wrapped_dek_password + protection_salt + content_encrypted` 齐全——拿到 ENCRYPTION 无关的这三列即可离线爆破（口令最短 4 位，`protection.js:68`）。同时 `/unlock` 无限失败锁定，仅受 apiLimiter 300 次/分钟（`rateLimiter.js:238-252`）→ 持会话令牌者在线爆破 4-6 位口令完全可行。
- 影响：安全 + 产品诚信（与「密码永不上传」的桌面代码注释 `useItemPassword.ts:2` 直接矛盾）。
- 修法：把 DEK 包装/解包全部移到客户端（复用 Rust/Dart 原语，服务端只存 wrapped DEK），口令永不出端；短期先加 /unlock 失败计数锁定 + 口令强度下限。

### [S2] 8. rotate-password 后恢复密钥通道永久失效（salt 轮换未同步 wrapped_dek_recovery）

- 证据：`protection.js:321-326` 更新 `wrapped_dek_password = $1, protection_salt = $2`（新 salt）；而 `wrapped_dek_recovery` 是用**旧 salt** 派生的 KEK 包装的（`protectionCrypto.js:105-115,240`），`/recovery` 解锁时用新 `protection_salt` 派生（`protection.js:245-250`）→ `unwrapDEKWithRecoveryKey` 必然返回 null → 500。
- 失败场景：用户设高级保护（保存了恢复密钥）→ 修改密码 → 忘新密码用恢复密钥找回 → 永远 500「Failed to decrypt content」，条目内容实质丢失。
- 影响：数据（恢复通道静默损毁）。
- 修法：wrapped DEK 各自携带独立 salt（存进 wrapped 串内），或 rotate 时拒绝/提示恢复密钥将失效并要求重新 setup。

### [S2] 9. 高级保护条目 remove 可不带密码 → 内容永久不可读但条目标记为「无保护」

- 证据：`protection.js:367-391`：`password` 缺省时跳过解密分支，仍执行 `SET protection_level='none', wrapped_dek_password=NULL, wrapped_dek_recovery=NULL, protection_salt=NULL`，`content_encrypted` 保留 DEK 密文。桌面 `ProtectionDialog.vue:190-193` 在 `unlockPassword` 为空时照样传 undefined。
- 失败场景：用户在未输入密码的状态下点「移除保护」→ 包装密钥全被清空 → 该条目内容任何人（含用户本人、含服务端）永久无法解密，而 UI 显示为普通条目，复制出来是 `iv:tag:ct` 乱码。
- 影响：数据（不可逆内容损毁）。
- 修法：advanced 级别 remove 强制要求密码或恢复密钥；解密成功后把 `content_encrypted` 回写为明文/重新走标准存储格式。

### [S2] 10. PIN 保护形同虚设：/unlock 对 pin 级条目不做任何校验直接返回内容

- 证据：`protection.js:162-169`
  ```js
  if (item.protection_level === 'pin') {
    // PIN protection: verify PIN and return content
    // For now, return the encrypted content (client will handle PIN verification)
    res.json({ success: true, level: 'pin', content: item.content_encrypted });
  }
  ```
  非 E2E 条目的 `content_encrypted` 就是明文（见判定节）。
- 失败场景：攻击者拿到用户会话令牌（XSS/设备失陷）后直接 `POST /api/protection/unlock {itemId, password:'x'}` → 无需知道 PIN 即返回明文内容；PIN 只是客户端 UI 锁。
- 影响：安全（保护级别语义虚假）。
- 修法：pin 级要么服务端校验 PIN（PIN 哈希落库），要么产品文案明示 PIN 仅为界面遮挡；同 #7 一并重构。

### [S2] 11. 三条 DB 删除路径不删磁盘文件 → 孤儿文件无界累积且无任何对账清理

- 证据：`routes/clipboard.js:1054-1057`（单删）、`:1113-1116`（批删 ≤500）只 `DELETE FROM clipboard_items`；`db/cleanup.js:27-31` 过期条目同样只删 DB；`fileRetentionCleanup.js` 仅对 **DB 中仍存在**的条目删文件（:249-284），磁盘清扫只覆盖 chunks/tmp（:292-357），不覆盖 `uploads/files`、`uploads/images`、`uploads/shared`。
- 失败场景：用户删除一个 1GB 文件条目（走 clipboard DELETE）→ DB 行没了，磁盘文件永存；长期运行磁盘只增不减，写满后所有上传 500，且无任何任务能回收（DB 已无索引指向这些文件）。
- 影响：可用性 + 成本（磁盘耗尽）+ 隐私（「已删除」文件仍在盘上）。
- 修法：clipboard 删除路径复用 `deleteStoredClipFiles`；增加周期性「磁盘文件 ↔ DB 引用」对账任务清理无主文件（带宽限期）。

### [S2] 12. 分享文件孤儿与外链永存：upload-file 未建链的文件、过期链接的文件均无清理

- 证据：`sharedLinks.js:157-180`（upload-file 落盘 `uploads/shared/<fileKey>/`，不建任何记录）；过期仅在访问时判断（:316,385），无后台删除；`fileRetentionCleanup.js` 全文不涉及 `uploads/shared`。
- 失败场景：客户端上传后放弃创建链接（或链接过期一年）→ 文件永久占盘；「过期即失效」只是访问层假象，数据仍在。
- 影响：隐私 + 磁盘泄漏。
- 修法：把 `uploads/shared/<uuid>` 纳入保留期清扫（无 DB 引用且 mtime 超期即删）。

### [S2] 13. 分块上传配额可绕过 + 各层大小限制互相矛盾

- 证据：init 只按**声明的** `fileSize` 校验配额（`chunked-upload.js:173-216`）；单片上限 12MB（:164）但 complete 只数片数不核总字节（:420-431）；`mergeChunks` 照单全收（`utils/storage.js:45-64`）；DB `content_size` 写入的是声明值（`chunked-upload.js:549,564`）。nginx（`nginx/conf.d/clipsync.conf`，仅 `docker-compose.multi.yml:155-165` 使用）全文件无 `client_max_body_size` → 默认 1MB，与后端 multer 1GB（`media.js:95`）差 3 个数量级。
- 失败场景：(a) Free 用户 init 声明 fileSize=1KB、totalChunks=90，实际传 ~1GB → 配额与存储统计全部失真，磁盘被合法吃掉；(b) 一旦启用 multi/nginx 部署，所有 >1MB 的正常上传被 nginx 413 拒绝——功能整体不可用。
- 影响：钱（配额=计费基础被绕过）+ 可用性（nginx 路径全挂）。
- 修法：complete 时校验 `Σ chunk 实际字节 ≈ fileSize` 且重跑配额；nginx 显式 `client_max_body_size` 与后端上限对齐。

### [S2] 14. chunked-upload 的 MIME 白名单/危险扩展名黑名单是死代码，`.exe`/`.js` 可上传

- 证据：`chunked-upload.js:19-56` `ALLOWED_MIME_TYPES`、`:59-66` `DANGEROUS_EXTENSIONS` 全文件零引用；实际只查 `BLOCKED_SCRIPT_EXTENSIONS`（:182-198），其中无 `.exe/.msi/.js/.py`；`mimeType` 字段完全未校验、原样入库并在下载时作为 `Content-Type` 返回（`media.js:613,626`）。
- 失败场景：用户（或恶意脚本）经 chunked 上传 `evil.exe`、声明 mimeType=`text/html` → 成功入库；下载虽强制 `attachment`（`media.js:614,627`）不构成存储型 XSS，但与 `media.js:99` 黑名单、注释宣称的「安全白名单」三套口径互相矛盾，防线名存实亡。
- 影响：安全（策略漂移）+ 代码诚信。
- 修法：删死代码或真正接线：init 校验 mimeType ∈ 白名单、扩展名 ∉ 黑名单，三处口径合一。

### [S2] 15. SVG / dataURL 图片在 API 源上 inline 输出（自存储型 XSS 面）

- 证据：`media.js:49` `IMAGE_TYPES` 含 `image/svg+xml`；preview 以 `Content-Type: metadata.mimeType` inline 流式返回（:913-916）；download 对 dataURL 图片分支 `Content-Disposition: inline` 且 mime 取自客户端 dataURL 头（:794-802）。
- 失败场景：用户（或向其账号注入条目的恶意客户端）上传含 `<script>` 的 SVG / `data:image/svg+xml` 条目，浏览器打开 `/api/media/:id/preview` 即在 API 源执行脚本，可窃取同源的 API 响应/CSRF token。因条目按属主隔离（`WHERE user_id=$2`），当前仅自 XSS 或「恶意客户端注入」场景，但 API 源无 CSP、执行面真实存在。
- 影响：安全（中）。
- 修法：SVG 一律 `Content-Disposition: attachment` + `Content-Security-Policy: sandbox`；dataURL 分支去掉 inline。

### [S2] 16. 备份只备 DB，不备 uploads 文件

- 证据：`scripts/backup-db.sh:25`（仅 `pg_dump ... | gzip`），全脚本无 uploads/文件备份逻辑；`docker-compose.prod.yml:126` 用户文件在宿主机 bind mount `./src/server/uploads`。
- 失败场景：磁盘损坏/误删（含问题 #3 的攻击）后按备份恢复 → DB 记录齐全但所有图片/文件 404，用户付费同步的文件资产归零且不可追责恢复。
- 影响：数据（不可恢复）。属脚本缺口而非「缺对象存储」外部依赖，故不在排除项内。
- 修法：backup 脚本追加 uploads 目录增量归档（tar + 校验和），与 DB 备份同保留策略。

### [S2] 17. `ENCRYPTION_KEY` 生产校验可被示例值原文通过

- 证据：`utils/encryption.js:19` `DEFAULT_KEYS = ['default_master_key_32b','default_iv_12b','dev_encryption_key_32chars_min!!']`；`.env.production.example:25` `ENCRYPTION_KEY=CHANGE_ME_ENCRYPTION_KEY_32_CHARS!!`（33 字符，不在黑名单）。
- 失败场景：运维直接 `cp .env.production.example .env.production` 忘改 → 生产通过全部启动校验（:25-39），shared_links 正文与 AI API key 全部用仓库公开的示例密钥加密 → 拖库即解密。
- 影响：安全（公开密钥加密生产数据）。
- 修法：生产启动强制拒绝包含 `CHANGE_ME` 前缀的值；或要求密钥为 64 位 hex/base64 随机格式。

### [S3] 18. `crypto/keyExchange.js` 的 `DeviceKeyManager` 是危险死代码

- 证据：`keyExchange.js:188-273`（服务端内存生成/保存设备**私钥**）；全仓唯一消费点只有 `isValidDevicePublicKey`（`routes/device.js:4`）。且 `encryptForDevice` 生成 salt 却从未参与派生，直接把 ECDH 原始输出当 AES 密钥（:242-244），`deriveKey` 无人调用。
- 失败场景：无（未接线）；但「服务端管私钥」与 E2E 叙事相悖，一旦被误用即击穿 E2E。
- 影响：代码异味 / 未来风险。
- 修法：删除 DeviceKeyManager 与 encryptForDevice/decryptFromDevice，保留公钥校验函数。

### [S3] 19. `utils/encryption.js` 的固定 IV 配置是误导性死代码

- 证据：`encryption.js:56,71`（读取并校验 `ENCRYPTION_IV`）但 `encrypt()` 每次 `crypto.randomBytes(IV_LENGTH)`（:91），常量 `IV` 无任何消费点。
- 失败场景：无实际危害（随机 IV 是对的），但运维会误以为需要维护一个全局 IV，且文档头注释（:13）继续强化该误解。
- 影响：代码异味。
- 修法：删除 `ENCRYPTION_IV` 相关代码与注释。

### [S3] 20. 桌面 `ItemPasswordDialog.vue` 死组件 + 不兼容的 `v1:` 客户端密码格式

- 证据：`ItemPasswordDialog.vue:98` 调用 `pw.encryptContent`，但全仓无任何文件 import `ItemPasswordDialog`（grep 仅命中自身）；`useItemPassword.ts:3-7` 格式 `v1:<salt>:<iv>:<ct>`（PBKDF2-SHA256）与服务端 DEK 方案（SHA-512）互不兼容，移动端无 `v1:` 解析实现（grep 无命中）。
- 失败场景：若未来有人把该对话框接线，桌面产生的 `v1:` 密文移动端永远解不开（S0 级跨端断裂的引信）。
- 影响：死代码 + 潜在跨端不一致。
- 修法：删除组件或统一到单一方案（推荐纯客户端方案并让移动端补齐实现）。

### [S3] 21. chunkIndex 非数字时 NaN 通过校验

- 证据：`chunked-upload.js:262,279-281`：`parseInt('abc')=NaN`，`NaN < 0 || NaN >= totalChunks` 均为 false → 放行，写出 `chunk_NaN` 垃圾文件；且 `uploadedChunks.includes(NaN)` 为 true（SameValueZero）→ 计数污染，complete 片数校验可被虚增。
- 失败场景：畸形客户端反复传 `chunkIndex=abc` → complete 判定「片齐」但 merge 读 `chunk_0..N-1` ENOENT → 500 + 垃圾分片残留 24h。
- 影响：健壮性（轻微）。
- 修法：`Number.isInteger(chunkIndexNum)` 前置校验。

### [S3] 22. `mergeChunks` 非原子写 + `tests/e2e.test.js` 整体 skip

- 证据：`utils/storage.js:45-59` 直接 `createWriteStream(mergedPath)` 写最终路径（无 tmp+rename），中途崩溃留下半截「正式」文件；`tests/e2e.test.js:31` `describe.skip('端到端测试 - 完整用户旅程')`。
- 失败场景：合并中断 → DB 未写入但 uploads 根目录出现孤儿半截文件（该目录不在任何清扫范围）。
- 影响：轻微（孤儿文件 + 死测试）。
- 修法：写 `.merging` 临时名后 rename；恢复或删除 skip 的测试。

### [S3] 23. 分享链接缺访问次数上限/密码；token 80-bit；原条目删除不影响已分享内容

- 证据：`sharedLinks.js:31` `TOKEN_BYTES = 10`（20 hex，80-bit，暴力枚举不现实但低于 128-bit 惯例）；public 路由只校验过期（:312-318），无 max-views、无口令；分享创建时内容被**解密复制**进 `shared_links.content_encrypted`（服务端密钥加密，:222-231），删除原条目不撤销链接。
- 失败场景：用户分享 E2E 条目 → 客户端解密后明文交服务端存储并公开吐给任何持 token 者——「分享」是 E2E 的合法破口，但产品未向用户明示该语义。
- 影响：产品语义/隐私预期（轻中）。
- 修法：增加可选访问密码与 max-views；UI 明示「分享将解密此内容」。

### [S3] 24. GDPR 导出不含正文与文件本体

- 证据：`auth.js:1489-1494` 导出仅 `content_preview/metadata` 且 `LIMIT 1000`，无 `content_encrypted` 正文、无文件打包；`:1560-1578` 仅 JSON。
- 失败场景：用户行使可携带权 → 拿到的「全部数据」缺正文与文件，不满足 Art.20 完整性。
- 影响：合规（轻中）。
- 修法：导出含正文（明文条目）与文件 zip（或下载清单）。

### [S3] 25. `pbkdf2Sync` 阻塞事件循环 + `decryptField` 失败静默返回密文

- 证据：`protectionCrypto.js:43` `crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha512')`（每次 unlock/setup 同步阻塞 ~50-100ms）；`utils/encryption.js:181-184` 解密失败 `return ciphertext`（调用方拿到密文当明文用，可能把 `iv:tag:ct` 串展示给用户）。
- 影响：可用性（轻）/数据展示错误（轻）。
- 修法：改 `crypto.pbkdf2` 异步；decryptField 失败返回 null 并由调用方显式处理。

## 测试有效性评估

| 测试 | 实际覆盖 | 缺口 |
|---|---|---|
| `tests/crypto.test.js`（232 行） | 只测 `crypto/keyExchange.js`——即**生产未使用的死模块**；含「同明文不同密文」的 IV 随机性断言 | 未测 `utils/encryption.js`（生产 at-rest 加密）、未测 `protectionCrypto.js`（DEK 方案）、未测 E2E 向量（服务端无 E2E 解密属合理，但信封结构校验 `clipboard.js:573-601` 也无单测） |
| E2E 向量 `e2e-vector.json` | Rust `cargo test`（`e2e_crypto.rs:518-687`，含非法公钥拒绝、非确定性、错误私钥失败）与 Dart `e2e_crypto_test.dart` 均硬编码对拍——**真实有效** | 两端是硬编码常量拷贝而非读 JSON 文件，向量更新需三处手改（漂移风险）；服务端 CI 不跑这两套 |
| `tests/storage.test.js` | local 后端 write/read/merge/delete 契约 | 无路径穿越负例、无 S3 分支（依赖未装，外部审计 #7 已录）、无并发/中断合并测试 |
| `tests/invoice-download.test.js` | 下载鉴权好范例：越权 403/404、非法 UUID、真 PDF 校验（:202-235） | **同模式未复制到** `media/:id/download`、`shared-links/public/*`、`protection/*`——grep 全 tests 目录，这三个路由零覆盖 |
| `tests/e2e.test.js` | 整文件 `describe.skip`（:31） | 死测试 |
| 本次风险无覆盖清单 | — | sharedLinks fileKey 穿越（#2/#3）、chunked multer 穿越（#4）、验证码随机性（#5）、GDPR 文件删除（#6）、rotate 破坏 recovery（#8）、remove 数据损毁（#9）、PIN 绕过（#10）、配额绕过（#13） |

## 设计层面的观察

- **本地磁盘单实例存储 / 无对象存储 / 多实例不共享 uploads**：属外部依赖排除项（`docs/audit/external-dependency-audit-2026-09-09.md` D1、#7），不重复报；但注意 `utils/storage.js` 的 S3 分支因依赖未装根本跑不起来（外部审计已录），chunked-upload 的 `STORAGE_BACKEND !== 'local'` 分支同样是不可达路径。
- **E2E 是「旁路」而非「底座」**：服务端对 E2E 全程透传的设计干净（信封校验、OCR/查重/预览三处降级守卫都真实存在），但明文路径才是默认主干，两套语义长期并存使 `content_encrypted` 列一名三义（明文正文 / 落盘文件名 / E2E 密文），靠 `metadata.e2e`、`content_type`、前缀嗅探区分——每个新消费点都是踩坑位（`aiOcr.js` 的注释即是自白）。
- **条目密码双轨制**（服务端 DEK vs 桌面死代码 v1:）与 **PIN 纯 UI 语义** 表明 protection 子系统是赶工产物，注释里两处 "For now" 自认临时。上线前应明确唯一方案。
- **分享 = 解密再加密的合法 E2E 破口**：`shared_links.content_encrypted` 用服务端 `ENCRYPTION_KEY` 加密（at-rest 而非 E2E），公开接口按 token 吐明文——设计上自洽，但需在产品文案中承认。
- **清理体系有分层意识但不闭环**：fileRetentionCleanup 的基线保护、安全文件名校验、批删都很稳（误删防护到位，值得肯定），缺的是「无 DB 引用的孤儿文件」这最后一块，以及 shared/uploads 目录。
- **无密钥轮换能力**：`ENCRYPTION_KEY` 单密钥、密文无 key-version 字段；`generateNewKey/encryptKeyWithRSA`（`encryption.js:228-262`）是无消费点的半成品。轮换一次即令历史 shared_links/AI key 密文全部失效。

## 建议补充的功能（按性价比排序）

1. **fileKey/uploadId 等一切入路径参数的 containment 校验工具函数**（`resolveWithin(base, userPath)`），一次性堵 #2/#3/#4，半天工作量换三个 S0/S1。
2. **`crypto.randomInt` 替换全部 `Math.random` 安全用途**（#5，一小时）。
3. **删号/删条目/过期清理的文件级联删除 + 每日孤儿文件对账任务**（#6/#11/#12，一天）。
4. **E2E 默认开启（或首启强引导）+ README/用户手册如实改写**（#1，产品决策 + 文案半天）。
5. **backup-db.sh 增加 uploads 增量归档**（#16，半天）。
6. **/unlock、/recovery 失败计数锁定（如 10 次/15 分钟）+ 口令最短 8 位**（#7 短期缓解，半天）。
7. **条目密码统一为纯客户端方案**：移动端实现 `v1:` 格式解密，服务端 protection 路由降级为存储 wrapped blob（一周内）。
8. **分享链接加访问密码 + max-views + 「分享将解密内容」提示**（#23，1-2 天）。
9. **密钥版本化**：密文加 `kv` 前缀支持 ENCRYPTION_KEY 轮换（2-3 天）。
