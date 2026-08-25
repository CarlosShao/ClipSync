# Webhook 集成指南

本文档介绍如何配置和使用 ClipSync 的 Webhook 签名验证功能。

## 功能概述

ClipSync 支持多种支付渠道的 Webhook 回调，并提供了签名验证机制以确保 Webhook 请求的安全性。

支持的支付渠道：
- 微信支付（WeChat Pay）
- 支付宝（Alipay）
- Stripe

## 安全特性

### 1. 签名验证

每个支付渠道都有独立的签名验证中间件，确保 Webhook 请求来自合法的支付平台。

#### 微信支付

**签名算法**: HMAC-SHA256

**请求头**:
- `x-wxp-signature`: 签名
- `x-wxp-timestamp`: 时间戳
- `x-wxp-nonce`: 随机字符串

**验签流程**:
1. 构造验签名串: `${timestamp}\n${nonce}\n${body}\n`
2. 使用 APIv3 密钥计算 HMAC-SHA256 签名
3. 比较计算的签名与请求头中的签名

**配置示例**:
```javascript
import { createWeChatSignatureVerifier } from './middleware/webhook-signature.js';

const wechatWebhookMiddleware = createWeChatSignatureVerifier(process.env.WECHAT_API_SECRET);

app.post('/api/payments/wechat/webhook', wechatWebhookMiddleware, (req, res) => {
  // 处理微信支付 Webhook
});
```

#### 支付宝

**签名算法**: RSA2-SHA256

**请求头**:
- `x-alipay-signature`: 签名
- `x-alipay-sig-type`: 签名类型（可选，默认 RSA2）

**验签流程**:
1. 去除 sign 和 sign_type 参数
2. 参数名按字典序排序，构造参数字符串
3. 使用支付宝公钥验证签名

**配置示例**:
```javascript
import { createAlipaySignatureVerifier } from './middleware/webhook-signature.js';

const alipayWebhookMiddleware = createAlipaySignatureVerifier(process.env.ALIPAY_PUBLIC_KEY);

app.post('/api/payments/alipay/webhook', alipayWebhookMiddleware, (req, res) => {
  // 处理支付宝 Webhook
});
```

#### Stripe

**签名算法**: HMAC-SHA256

**请求头**:
- `stripe-signature`: 签名（格式: `t=${timestamp},v1=${signature}`）

**验签流程**:
1. 提取时间戳和签名
2. 构造签名字段: `${timestamp}.${body}`
3. 使用 Webhook Secret 计算 HMAC-SHA256 签名
4. 比较计算的签名与请求头中的签名

**配置示例**:
```javascript
import { createStripeSignatureVerifier } from './middleware/webhook-signature.js';

const stripeWebhookMiddleware = createStripeSignatureVerifier(process.env.STRIPE_WEBHOOK_SECRET);

app.post('/api/payments/stripe/webhook', stripeWebhookMiddleware, (req, res) => {
  // 处理 Stripe Webhook
});
```

### 2. 幂等性保证

为了防止 Webhook 重复处理，ClipSync 提供了幂等性保证中间件。

**原理**: 每个 Webhook 请求包含一个唯一的幂等性键（Idempotency Key），服务器会记录已处理的键，重复请求将直接返回之前的结果。

**配置示例**:
```javascript
import { webhookIdempotencyMiddleware } from './middleware/idempotency.js';

app.post('/api/payments/wechat/webhook',
  wechatWebhookMiddleware,
  webhookIdempotencyMiddleware(),
  (req, res) => {
    // 处理 Webhook
  }
);
```

**幂等性键提取**:
- 微信支付: 从请求头 `x-wxp-event-id` 提取
- 支付宝: 从请求体 `notify_id` 提取
- Stripe: 从请求头 `stripe-idempotency-key` 提取

### 3. 自动验证

`webhookSignatureVerifier` 中间件会自动检测支付渠道并应用相应的签名验证。

**使用方式**:
```javascript
import { webhookSignatureVerifier } from './middleware/webhook-signature.js';

app.post('/api/payments/:channel/webhook',
  webhookSignatureVerifier(),
  (req, res) => {
    // 处理 Webhook
  }
);
```

**自动检测逻辑**:
- 检查请求路径中的渠道名称
- 或者检查请求头中的渠道标识

## 环境变量配置

在 `.env` 文件中配置以下变量：

```bash
# 微信支付
WECHAT_API_KEY=your_api_key
WECHAT_API_SECRET=your_apiv3_secret

# 支付宝
ALIPAY_APP_ID=your_app_id
ALIPAY_PUBLIC_KEY=your_public_key
ALIPAY_PRIVATE_KEY=your_private_key

# Stripe
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret
STRIPE_API_KEY=sk_test_your_api_key
```

## 错误处理

签名验证失败将返回 401 状态码：

```json
{
  "error": "Invalid signature"
}
```

幂等性检查失败将返回 409 状态码：

```json
{
  "error": "Duplicate webhook request",
  "idempotencyKey": "key_123456"
}
```

## 测试

运行 Webhook 测试：

```bash
cd src/server
npm test -- --run tests/webhook.test.js
```

## 安全最佳实践

1. **使用 HTTPS**: 生产环境必须使用 HTTPS 保护 Webhook 回调
2. **验证签名**: 始终启用签名验证，不要跳过
3. **幂等性处理**: 确保 Webhook 处理逻辑支持幂等性
4. **日志记录**: 记录所有 Webhook 请求和验证结果
5. **定期轮换密钥**: 定期更换 API 密钥和 Webhook Secret

## 故障排查

### 签名验证失败

1. 检查环境变量是否正确配置
2. 确认使用的签名算法与支付平台一致
3. 检查请求体是否被修改（签名基于原始请求体）
4. 查看服务器日志获取详细错误信息

### 幂等性问题

1. 检查幂等性键是否正确提取
2. 确认存储后端可用（当前使用内存存储，生产环境建议使用 Redis）
3. 检查幂等性键的 TTL 配置

## 生产环境部署

### Redis 配置

当前幂等性保证使用内存存储，生产环境建议使用 Redis：

```javascript
// 未来版本将支持 Redis 存储
// 当前版本使用内存存储，重启后会丢失幂等性记录
```

### 监控和告警

建议监控以下指标：
- Webhook 请求数量
- 签名验证失败次数
- 幂等性检查命中次数
- Webhook 处理延迟

## 参考资料

- [微信支付 APIv3 签名验证](https://pay.weixin.qq.com/wiki/doc/apiv3/wechatpay/wechatpay6_0.shtml)
- [支付宝开放平台签名验签](https://opendocs.alipay.com/open/270/105898)
- [Stripe Webhook 签名验证](https://stripe.com/docs/webhooks/signature)
