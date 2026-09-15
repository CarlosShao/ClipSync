# ClipSync 端到端加密协议 v1（E2E Protocol v1）

> 本文档是 E2E 工单线（B1-B11）的**唯一实现契约**。各端（桌面 Rust / 桌面前端 / 移动 Flutter / 服务端）不得自行偏离；实现与本文冲突时，以本文为准并在交付报告标注。
> 测试向量：`docs/plans/e2e-vector.json`（所有加密实现必须对该向量对拍通过）。

---

## 1. 算法栈

| 用途 | 算法 | 说明 |
|---|---|---|
| 设备身份密钥 | ECDH P-256（secp256r1） | 每设备一对静态密钥；公钥以 **未压缩点 base64**（65 字节）注册到 `devices.public_key` |
| 内容加密 | AES-256-GCM | 每条内容生成随机 256-bit 会话密钥 K + 随机 96-bit IV |
| 密钥封装 | ECDH(发送方临时私钥, 接收方静态公钥) → HKDF-SHA256 | salt = `"clipsync-e2e-v1"`（ASCII），info = 接收方 deviceId（ASCII），输出 32 字节包装密钥；用包装密钥 AES-256-GCM 加密 K（独立 IV） |
| 每条内容 | 发送方生成一次性临时 ECDH 密钥对 | 临时公钥 epk 随信封下发，提供同条目内接收者间隔离 |

实现注意：P-256 公钥统一使用 **未压缩点格式（0x04 || X || Y，65 字节）** 的 base64 编码传输与存储。

## 2. 信封格式（信条目存储与广播）

- `content_encrypted` 列：`base64( ciphertext || GCM-tag(16B) )` —— 内容用 K + `iv` 加密后的密文与认证标签拼接。
- `metadata.e2e`（JSON 对象，服务端原样透传、不解析内部）：

```json
{
  "v": 1,
  "alg": "ECDH-P256+HKDF-SHA256+A256GCM",
  "epk": "<base64 发送方临时公钥 65B>",
  "iv": "<base64 内容 IV 12B>",
  "keys": {
    "<deviceId>": { "w": "<base64 wrappedKey 48B>", "iv": "<base64 wrap IV 12B>" }
  }
}
```

- `content_preview`：E2E 条目固定为 `[E2E]`（服务端 tsvector 索引占位串，全文搜索自然降级）。
- **判定规则**：`metadata.e2e` 存在且 `v === 1` → E2E 条目；否则 → 旧明文条目，全链路按旧逻辑处理。

## 3. 加解密流程

**发送（任一客户端）**：
1. 读取账号全部设备的 `public_key`（`GET /api/devices`）；
2. 生成 K(32B)、iv(12B)、临时 ECDH 对；`ciphertext = AES-256-GCM(K, iv, plaintext)`；
3. 对每个接收设备 d：`wrapKey = HKDF-SHA256(ECDH(ephPriv, pub_d), salt="clipsync-e2e-v1", info=d.deviceId)`；`keys[d.id] = { w: AES-GCM(wrapKey, wiv, K), iv: wiv }`；
4. 组信封上传；`keys` 中**必须包含发送设备自己**（多端同账号回写场景）。

**接收（任一客户端）**：
1. 条目带 `metadata.e2e` 且 `keys` 含本机 deviceId → 取本机静态私钥；
2. `wrapKey = HKDF-SHA256(ECDH(myPriv, epk), salt, info=myDeviceId)` → 解包 K → AES-GCM 解密内容；
3. `keys` 不含本机 → 显示占位（「加密条目：本设备不在接收列表」），复制/解密操作禁用并提示。

## 4. 密钥存储

| 端 | 私钥位置 | 要求 |
|---|---|---|
| 桌面（Rust） | app-data 目录 `e2e-key.pem`（0600，仅当前用户） | 启动时惰性生成（`e2e_ensure_keypair`）；私钥永不出 Rust 进程，解密经 invoke 完成 |
| 移动（Flutter） | `flutter_secure_storage`（key: `e2e_device_priv_v1`） | 首次注册设备时生成；私钥不落明文文件 |

公钥注册：设备注册（`POST /api/devices`）与配对 redeem 请求体可选携带公钥（**请求体字段名为 `publicKey`**，服务端 B2 实现解构 camelCase；落库列/GET 响应为 `public_key`）；已注册设备可通过 `PUT /api/devices/:id` 补交。

## 5. 服务端行为（透传，不解析）

- POST /api/clipboard：原样存 `content_encrypted` 与 `metadata`（仅做 `metadata.e2e` 结构与总长校验：`keys` ≤ 32 项、单 wrapped ≤ 256B，非法 400）。
- 广播 `new_clipboard`：payload 含完整 `metadata`（信封在内）+ `contentPreview`（客户端已置 `[E2E]`）。
- 灰度开关：**不引入服务端 flag**。客户端侧双闸门 = 套餐特性位 `e2e_encryption`（套餐 JSON 已存在，三档全 true）+ 用户级设置开关（每端本地偏好，默认关闭）。任一不满足 → 走旧明文路径。服务端对两种格式**恒可存**，无需任何开关判断。

## 6. 明文功能降级决策（逐项冻结）

| 功能 | E2E 条目下的行为 | 涉及工单 |
|---|---|---|
| 全文搜索（tsvector） | content_preview 为占位 → 自然搜不到内容；按类型/来源/时间筛选不受影响；不新增 UI（v1 接受） | B1 |
| OCR | `metadata.e2e` 存在即跳过 OCR 后台任务 | B4 |
| AI 图片查重/相似 | 跳过 E2E 条目 | B4 |
| 通知预览 | 客户端显示「[端到端加密内容]」占位 | B6/B7/B9/B10 |
| text-preview（文件文本预览） | 对 E2E 文件条目返回 `409 { error: 'E2E_FILE' }`，不再读盘返回明文 | B3 |
| 文件落盘 | 客户端加密后的密文字节直接落盘（服务端磁盘无明文） | B3 |
| 管理台导出 | 维持 preview+元数据（占位串），无改动 | — |
| 条目级密码保护（应用层） | 不变；与 E2E 正交叠加（E2E 加密的是密码保护后的密文/或普通明文，两层独立） | — |

## 7. 限制与已知取舍（v1，B11 落地后修订）

1. **新设备解不开历史**：`keys` 只含发送时刻已注册且公钥可得设备——之后注册的设备对历史 E2E 条目显示占位。密钥重封装/恢复机制留待 v2。
2. **设备解绑**：解绑设备的 keys 项保留在历史信封中（无害：私钥随解绑设备）；不主动重加密历史。
3. **发送时无在线收件人公钥**（账号只有本机一台设备）：仍对自己封装（keys 含自身），支持同设备多端场景与后续注册设备的占位语义。
4. **混合环境降级策略（B11② 决策修订）**：实现采用「**有公钥收件人 ≥1 即加密**」而非 B0 早期的「含无公钥设备则整体回退明文」——无公钥设备看到 `[E2E]` 占位（不崩溃、复制被守卫拦截），密文安全性优先于全员可读性。此差异已与联调清单 #5 对齐；「强制只发加密」独立开关不再需要（该策略本身即为最严格态）。
5. **加密失败 fail-closed**：开关开启但 Rust/Flutter 原语调用失败（非「无收件人」）→ 中止发送并提示，**绝不回退明文**（用户意图是加密）。
6. **E2E 文件大小上限**：桌面 64MB（`E2E_FILE_MAX_BYTES`，整文件 b64 过 IPC 的内存代价），超限回退明文并发送提示；移动端不设额外上限（跟随套餐限制）。

## 8. 标准测试向量

见 `docs/plans/e2e-vector.json`。字段说明：
- `fixture.recipientPrivateKeyB64 / recipientPublicKeyB64`：接收方设备静态密钥对（deviceId = `fixture.recipientDeviceId`）；
- `envelope`：按本协议构造的完整信封（ciphertext/epk/iv/keys）；
- `expectedPlaintext`：解密必须还原的明文。

**各端对拍要求**：实现方用 fixture 私钥对 envelope 执行「解包 K → 解密」，必须得到 `expectedPlaintext`；并反向用 fixture 公钥作为接收方公钥执行「加密 → 自解密」往返。两端（Rust/Flutter）向量对拍通过是 B5/B8 的验收项。

## 9. 联调结果回填区（B11 填写）

### 9.1 静态验证（已完成）

| 项 | 结果 |
|---|---|
| Rust 向量对拍（B5 `cargo test e2e`） | ✅ 6/6 通过：fixture 信封解出 `hello clipsync 端到端加密测试 ✨`；自往返/非法公钥拒绝/非确定性加密用例全过 |
| Flutter 向量对拍（B8 `flutter test`） | ✅ 21/21 通过（14 新增 + 7 存量）：同一 fixture 在 Dart 实现下解出相同明文——**Rust ↔ Flutter 跨端互操作成立**；信封结构断言（epk 65B / w 48B / iv 12B / 含 ciphertext）全过 |
| 服务端信封校验（B1） | ✅ `node --check` 通过；结构/长度上限（keys ≤32、wrapped ≤256B、iv ≤32B、epk ≤128B）非法 400 |
| 明文功能降级守卫（B3/B4） | ✅ `node --check` 通过：OCR 双保险守卫、imageHash E2E 跳过（含客户端传入哈希不落库）、text-preview 409 门禁 |
| 存量明文标记（B11① migrate.js） | ✅ 幂等 UPDATE 段：`metadata.e2e` 不存在 → 补 `e2eLegacy=true`；布尔判定逻辑单测通过 |
| Flutter 端到端链路静态验证（B9/B10） | ✅ `flutter analyze` 0 error、`flutter test` 21/21：文本加密上传（双闸门/fail-closed/离线密封队列）、接收解密（WS/分页/复制三挂点）、图片三态补线（截屏/分享/重放）、回写钩子解密守卫 |
| 桌面 vue-tsc / 服务端 node --check | ✅ 0 error（A 线 + B6/B7 全量改动后复跑） |

### 9.2 动态联调清单（待执行）

| # | 场景 | 预期 | 结果 |
|---|---|---|---|
| 1 | 桌面 A（开关开）复制文本 → 服务端 DB | `content_encrypted` 为 base64 密文、`content_preview='[E2E]'`、`metadata.e2e` 信封完整 | 待联调 |
| 2 | 桌面 B（同账号已配对）收到 WS 广播 | 列表显示占位；复制/抽屉打开时解密出明文；自动写剪贴板为明文 | 待联调 |
| 3 | 手机（开关开）复制 → 桌面接收 | 桌面解密可见；通知显示「端到端加密内容」占位 | 待联调 |
| 4 | 桌面（开关开）→ 手机接收 | 手机解密入本地库与剪贴板 | 待联调 |
| 5 | 无公钥第三方设备（未配对密钥） | 只见 `[E2E]` 占位；复制被守卫拦截并提示；不产生密文写入剪贴板 | 待联调 |
| 6 | 开关关闭回退 | 新条目明文入库（`metadata` 无 e2e），两端行为与旧版一致 | 待联调 |
| 7 | 明文↔密文共存 | 同一账号混合列表：旧条目正常、新条目按开关；搜索对 E2E 条目自然失效不报错 | 待联调 |
| 8 | E2E 图片 | 发送端图片正常显示；接收端经解密渲染；重复发送不进查重库（image_hash 为空） | 待联调 |
| 9 | E2E 大文件（>10MB 走 chunked） | 密文分片落盘；接收端下载后解密还原 | 待联调 |
| 10 | 离线队列 | 断网时加密条目入队（已含密文）；恢复网络后正常入库 | 待联调 |
| 11 | 条目密码保护 × E2E 叠加 | 双层独立生效：先应用层密码、再 E2E；解锁流程不互相干扰 | 待联调 |
| 12 | flag/开关切换即时性 | 关闭后新条目立即回退明文；在途条目按各自条目元数据解密 | 待联调 |
