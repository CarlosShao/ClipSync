# ClipSync 支付渠道集成说明

> **文档版本**: v1.0  
> **最后更新**: 2026年6月24日  
> **作者**: AI助手  

---

## 概述

本文档说明 ClipSync 支付渠道集成的外部依赖、申请流程和接入步骤。

支付渠道集成是商业化上线的**硬性前置条件**。当前阶段（Stage 10）已完成核心订阅逻辑和Mock支付，真实支付渠道需要以下外部依赖：

1. **微信支付商户号**（国内主渠道）
2. **支付宝商户号**（国内备选）
3. **Stripe账号**（国际渠道）
4. **Apple 开发者账号**（iOS内购，已搁置）
5. **Google 开发者账号**（$25一次性，Android内购）

---

## 1. 微信支付集成

### 1.1 所需外部条件

| 条件 | 说明 | 获取方式 |
|------|------|----------|
| 微信支付商户号 | 用于接收微信支付款项 | [微信支付商户平台](https://pay.weixin.qq.com) 申请 |
| 商户号AppID | 微信开放平台应用AppID | 创建应用后获取 |
| 商户API密钥(APIv3 Key) | 用于签名和加解密 | 商户平台 → API安全 → 设置APIv3密钥 |
| 商户证书(serial_no, private_key, certificate) | 用于API调用身份验证 | 商户平台 → API安全 → 申请API证书 |
| 服务器IP白名单 | 微信支付回调通知的允许IP | 在商户平台配置 |

### 1.2 申请流程

1. **注册微信公众号/小程序/移动应用**
   - 前往 [微信开放平台](https://open.weixin.qq.com)
   - 创建应用（选择"移动应用"或"网站应用"）
   - 等待审核（1-3工作日）

2. **申请微信支付商户号**
   - 前往 [微信支付商户平台](https://pay.weixin.qq.com)
   - 提交企业资质（营业执照、法人身份证、对公账户）
   - 等待审核（1-3工作日）

3. **获取API密钥和证书**
   - 登录商户平台
   - 前往"账户中心" → "API安全"
   - 设置APIv3密钥
   - 申请API证书（下载证书文件）

4. **配置支付目录/授权域名**（仅JSAPI/Web支付需要）
   - 在商户平台配置支付授权目录
   - 配置H5支付域名

### 1.3 接入步骤（待完成）

1. **安装微信支付Node.js SDK**
   ```bash
   cd D:/work/java/AI-workspace/ClipSync/src/server
   npm install wechatpay-node-v3
   ```

2. **配置环境变量**
   ```.env
   # 微信支付
   WXPAY_MCH_ID=your_merchant_id
   WXPAY_APIV3_KEY=your_apiv3_key
   WXPAY_SERIAL_NO=your_cert_serial_no
   WXPAY_PRIVATE_KEY_PATH=./certs/wxpay_private_key.pem
   WXPAY_CERTIFICATE_PATH=./certs/wxpay_certificate.pem
   WXPAY_NOTIFY_URL=https://api.clipstream.work/api/webhooks/wechat-pay
   ```

3. **更新 `src/routes/payments.js`**
   - 取消注释微信支付相关代码
   - 实现 `createWeChatPayOrder()` 函数
   - 实现 `verifyWeChatSignature()` 函数
   - 测试JSAPI/H5/App支付

4. **部署证书文件**
   - 将私钥和证书文件放到服务器安全目录
   - 设置文件权限（仅Node.js进程可读）

5. **配置回调通知**
   - 在商户平台配置回调通知URL
   - 确保服务器能接收外部POST请求

---

## 2. 支付宝支付集成

### 2.1 所需外部条件

| 条件 | 说明 | 获取方式 |
|------|------|----------|
| 支付宝商户号 | 用于接收支付宝款项 | [支付宝开放平台](https://open.alipay.com) 申请 |
| AppID | 应用唯一标识 | 创建应用后获取 |
| 应用私钥(private_key) | 用于签名请求 | 使用支付宝密钥工具生成 |
| 支付宝公钥(alipay_public_key) | 用于验签回调通知 | 在开放平台获取 |
| 应用网关/授权回调地址 | 支付宝回调通知的URL | 在开放平台配置 |

### 2.2 申请流程

1. **注册支付宝开放平台账号**
   - 前往 [支付宝开放平台](https://open.alipay.com)
   - 使用企业支付宝账号登录

2. **创建网页&移动应用**
   - 前往"控制台" → "网页&移动应用"
   - 创建应用（选择"网页应用"或"移动应用"）
   - 等待审核（1-3工作日）

3. **接入支付功能**
   - 在应用详情页，添加"手机网站支付"和"App支付"功能
   - 配置密钥（使用支付宝密钥工具生成RSA2密钥对）
   - 上传应用公钥，获取支付宝公钥

4. **签约商户号**
   - 前往"商家中心"完成入驻
   - 提交企业资质
   - 等待审核（1-3工作日）

### 2.3 接入步骤（待完成）

1. **安装支付宝Node.js SDK**
   ```bash
   cd D:/work/java/AI-workspace/ClipSync/src/server
   npm install alipay-sdk
   ```

2. **配置环境变量**
   ```.env
   # 支付宝
   ALIPAY_APP_ID=your_app_id
   ALIPAY_PRIVATE_KEY_PATH=./certs/alipay_private_key.pem
   ALIPAY_PUBLIC_KEY_PATH=./certs/alipay_public_key.pem
   ALIPAY_NOTIFY_URL=https://api.clipstream.work/api/webhooks/alipay
   ALIPAY_RETURN_URL=https://clipstream.work/payment/result
   ```

3. **更新 `src/routes/payments.js`**
   - 取消注释支付宝支付相关代码
   - 实现 `createAlipayOrder()` 函数
   - 实现 `verifyAlipaySignature()` 函数
   - 测试手机网站支付和App支付

4. **部署密钥文件**
   - 将私钥和公钥文件放到服务器安全目录
   - 设置文件权限（仅Node.js进程可读）

5. **配置回调通知**
   - 在开放平台配置回调通知URL
   - 确保服务器能接收外部POST请求

---

## 3. Stripe国际支付集成

### 3.1 所需外部条件

| 条件 | 说明 | 获取方式 |
|------|------|----------|
| Stripe账号 | 用于接收国际信用卡款项 | [Stripe官网](https://stripe.com) 注册 |
| API密钥(API Key) | 用于调用Stripe API | 在Stripe Dashboard获取 |
| Webhook签名密钥(Webhook Secret) | 用于验证Webhook事件 | 在Stripe Dashboard配置Webhook时获取 |
| 企业资质（如需提现到对公账户） | Stripe要求的企业信息 | 在Stripe Dashboard提交 |

### 3.2 申请流程

1. **注册Stripe账号**
   - 前往 [Stripe官网](https://stripe.com)
   - 点击"Start now"注册
   - 填写邮箱、密码、地区（选择"China"或"Hong Kong"）

2. **激活账号**
   - 前往Stripe Dashboard
   - 完成"Activate your account"
   - 提交企业资质（营业执照、法人身份证、对公账户）
   - 等待审核（3-7工作日）

3. **获取API密钥**
   - 在Dashboard → Developers → API keys
   - 获取"Publishable key"和"Secret key"
   - 注意：测试模式使用test_开头的密钥

4. **配置Webhook**
   - 在Dashboard → Developers → Webhooks
   - 添加端点：https://api.clipstream.work/api/webhooks/stripe
   - 选择事件：checkout.session.completed, invoice.payment_failed等
   - 获取"Signing secret"

### 3.3 接入步骤（待完成）

1. **安装Stripe Node.js SDK**
   ```bash
   cd D:/work/java/AI-workspace/ClipSync/src/server
   npm install stripe
   ```

2. **配置环境变量**
   ```.env
   # Stripe
   STRIPE_SECRET_KEY=sk_test_your_secret_key
   STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret
   STRIPE_PRICE_ID_PRO=price_your_pro_price_id
   STRIPE_PRICE_ID_ENTERPRISE=price_your_enterprise_price_id
   ```

3. **更新 `src/routes/payments.js`**
   - 取消注释Stripe支付相关代码
   - 实现 `createStripeCheckoutSession()` 函数
   - 实现Stripe Webhook处理逻辑
   - 测试国际卡支付

4. **创建Stripe产品/价格**
   - 在Stripe Dashboard → Products
   - 创建"Pro"和"Enterprise"产品
   - 设置价格（¥9.9/月，¥29.9/月）
   - 获取Price ID并配置到环境变量

5. **配置Webhook**
   - 确保服务器能接收Stripe的Webhook通知
   - 测试Webhook事件处理

---

## 4. Apple IAP内购集成（已搁置）

### 4.1 所需外部条件

| 条件 | 说明 | 获取方式 |
|------|------|----------|
| Apple 开发者账号 | 用于发布iOS应用和配置内购 | [Apple Developer](https://developer.apple.com) 注册（$99/年） |
| 沙盒测试账号 | 用于测试内购 | 在App Store Connect创建 |
| 税务和银行信息 | 用于接收内购款项 | 在App Store Connect配置 |

### 4.2 当前状态

⚠️ **已搁置**（2026-06-24）：暂时缺少iOS测试设备，暂停开发。

### 4.3 恢复条件

1. 获得iOS测试设备（iPhone）
2. 注册Apple开发者账号（$99/年）
3. 在Apple Developer配置应用ID、App ID、内购产品ID

### 4.4 接入步骤（待恢复后完成）

1. **注册Apple开发者账号**
2. **在App Store Connect创建应用**
3. **配置内购产品**
   - 创建"com.clipsync.pro.monthly"产品ID
   - 设置价格（¥9.9/月）
   - 等待审核
4. **在Flutter项目中集成in_app_purchase插件**
5. **实现购买流程和恢复购买逻辑**
6. **验证收据（防止作弊）**

---

## 5. Google Play Billing集成

### 5.1 所需外部条件

| 条件 | 说明 | 获取方式 |
|------|------|----------|
| Google 开发者账号 | 用于发布Android应用和配置内购 | [Google Play Console](https://play.google.com/console) 注册（$25一次性） |
| 沙盒测试账号 | 用于测试内购 | 在Play Console创建 |
| 税务和银行信息 | 用于接收内购款项 | 在Play Console配置 |

### 5.2 申请流程

1. **注册Google开发者账号**
   - 前往 [Google Play Console](https://play.google.com/console)
   - 使用Google账号登录
   - 支付$25注册费（一次性）
   - 等待账号激活（几小时到1-2天）

2. **创建应用**
   - 在Play Console创建应用
   - 填写应用基本信息
   - 上传APK/AAB

3. **配置内购产品**
   - 在Play Console → 应用 → 商品详情
   - 创建"pro_monthly"产品ID
   - 设置价格（¥9.9/月）
   - 激活产品

### 5.3 接入步骤（待完成）

1. **在Flutter项目中集成in_app_purchase插件**
   ```yaml
   dependencies:
     in_app_purchase: ^3.1.7
   ```

2. **实现购买流程**
   - 查询可用产品
   - 发起购买
   - 处理购买结果
   - 验证购买令牌（防止作弊）

3. **实现恢复购买逻辑**
   - 调用 `InAppPurchase.instance.queryPastPurchases()`
   - 验证购买状态
   - 更新用户订阅状态

4. **配置服务器验证**（可选，增强安全性）
   - 在Play Console创建Service Account
   - 下载JSON密钥文件
   - 在后端实现购买令牌验证

---

## 6. 当前Mock支付说明

当前阶段使用Mock支付，支付流程如下：

1. 用户选择套餐，点击"订阅"
2. 后端创建支付订单（`payment_orders`表），状态为"pending"
3. 如果使用Mock支付（`payment_method = 'mock'`），则直接标记为"paid"
4. 更新用户订阅状态（`user_subscriptions`表）
5. 创建发票记录（`invoices`表）
6. 返回支付成功响应

**Mock支付仅用于开发和测试**。生产环境必须接入真实支付渠道。

---

## 7. 后续任务清单

当获得必要的外部依赖后，按以下顺序完成支付渠道集成：

### 7.1 微信支付集成（国内主渠道）

- [ ] 申请微信支付商户号
- [ ] 获取API密钥和证书
- [ ] 安装 `wechatpay-node-v3` SDK
- [ ] 配置环境变量
- [ ] 更新 `src/routes/payments.js` 中的 `createWeChatPayOrder()`
- [ ] 实现 `verifyWeChatSignature()`
- [ ] 部署证书文件
- [ ] 配置回调通知URL
- [ ] 测试JSAPI/H5/App支付
- [ ] 更新API测试文件

### 7.2 支付宝支付集成（国内备选）

- [ ] 申请支付宝商户号
- [ ] 获取应用私钥和支付宝公钥
- [ ] 安装 `alipay-sdk` SDK
- [ ] 配置环境变量
- [ ] 更新 `src/routes/payments.js` 中的 `createAlipayOrder()`
- [ ] 实现 `verifyAlipaySignature()`
- [ ] 部署密钥文件
- [ ] 配置回调通知URL
- [ ] 测试手机网站支付和App支付
- [ ] 更新API测试文件

### 7.3 Stripe国际支付集成

- [ ] 注册Stripe账号
- [ ] 完成企业资质认证
- [ ] 获取API密钥和Webhook签名密钥
- [ ] 创建Stripe产品和价格
- [ ] 安装 `stripe` SDK
- [ ] 配置环境变量
- [ ] 更新 `src/routes/payments.js` 中的 `createStripeCheckoutSession()`
- [ ] 实现Stripe Webhook处理逻辑
- [ ] 配置Webhook端点
- [ ] 测试国际卡支付
- [ ] 更新API测试文件

### 7.4 Apple IAP内购集成（已搁置，待恢复）

- [ ] 获得iOS测试设备
- [ ] 注册Apple开发者账号（$99/年）
- [ ] 在App Store Connect创建应用
- [ ] 配置内购产品
- [ ] 在Flutter项目中集成 `in_app_purchase` 插件
- [ ] 实现购买流程
- [ ] 实现恢复购买逻辑
- [ ] 验证收据
- [ ] 测试沙盒环境

### 7.5 Google Play Billing集成

- [ ] 注册Google开发者账号（$25一次性）
- [ ] 在Play Console创建应用
- [ ] 配置内购产品
- [ ] 在Flutter项目中集成 `in_app_purchase` 插件
- [ ] 实现购买流程
- [ ] 实现恢复购买逻辑
- [ ] 验证购买令牌
- [ ] 测试沙盒环境

---

## 8. 安全与合规检查清单

支付渠道集成涉及金融交易，必须注意安全与合规：

### 8.1 安全

- [ ] 所有API请求使用HTTPS（✅ 已在路线图中标记为外部依赖）
- [ ] Webhook签名验证（防止伪造回调）
- [ ] 幂等性保证（重复支付/重复回调不重复扣款）
- [ ] 敏感信息加密（卡号/支付密码不落库明文）
- [ ] 使用环境变量存储API密钥（不硬编码）
- [ ] 定期更换API密钥
- [ ] 限制Webhook接收IP（仅允许支付渠道的IP）

### 8.2 合规

- [ ] 中国税法合规（开具电子发票）
- [ ] GDPR合规（用户有权查看/删除支付记录）
- [ ] 退款流程（全额/部分退款、退款到原路）
- [ ] 财务对账（日终/月度对账报告生成）
- [ ] 用户协议和隐私政策更新（包含支付条款）
- [ ] 明确告知用户订阅条款（自动续费、取消政策）

---

## 9. 测试计划

支付渠道集成完成后，必须进行充分测试：

### 9.1 功能测试

- [ ] 创建订单
- [ ] 支付成功流程
- [ ] 支付失败流程
- [ ] 支付取消流程
- [ ] Webhook回调处理
- [ ] 签名验证（防伪造）
- [ ] 幂等性测试（重复回调）
- [ ] 退款流程
- [ ] 订阅升级/降级
- [ ] 订阅取消/恢复

### 9.2 安全测试

- [ ] SQL注入测试
- [ ] XSS测试
- [ ] CSRF测试
- [ ] 签名绕过测试
- [ ] 重放攻击测试

### 9.3 性能测试

- [ ] 并发支付请求
- [ ] Webhook并发处理
- [ ] 数据库事务回滚

---

## 10. 常见问题

### 10.1 微信支付报错"商户号不存在"

**原因**：使用了错误的商户号，或者商户号未激活。

**解决**：检查环境变量 `WXPAY_MCH_ID` 是否正确，登录微信支付商户平台确认商户号状态。

### 10.2 支付宝回调通知收不到

**原因**：服务器防火墙阻止、回调URL配置错误、网络不通。

**解决**：检查服务器防火墙规则，确认回调URL在支付宝开放平台已配置，使用 `curl` 测试URL可达性。

### 10.3 Stripe Webhook验签失败

**原因**：Webhook Secret配置错误，或者请求体在传输过程中被修改。

**解决**：检查环境变量 `STRIPE_WEBHOOK_SECRET` 是否正确，确保Webhook端点代码正确读取原始请求体（不参与JSON解析）。

---

## 11. 联系人

如果遇到支付渠道集成问题，请联系：

- **技术负责人**：[待填写]
- **财务负责人**：[待填写]
- **微信支付技术支持**：[微信支付官方文档](https://pay.weixin.qq.com/docs/)
- **支付宝技术支持**：[支付宝开放平台文档](https://open.alipay.com/docs/)
- **Stripe技术支持**：[Stripe官方文档](https://stripe.com/docs)

---

**文档结束**
