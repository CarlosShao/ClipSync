# 敏感信息加密集成指南

本文档介绍 ClipSync 的敏感信息加密功能，包括配置、使用和最佳实践。

## 功能概述

ClipSync 使用 AES-256-GCM 算法对敏感信息进行加密存储，保护用户隐私和数据安全。

加密的字段包括：
- 用户手机号（`phone_encrypted`）
- 用户邮箱（`email_encrypted`）
- 支付令牌（`payment_token_encrypted`）
- 订阅令牌（`subscription_token_encrypted`）

## 加密方案

### 混合加密方案

为了平衡安全性和查询性能，采用混合方案：
- **明文存储**: 用于查询的字段（如 `phone`、`email`）保持明文
- **加密存储**: 敏感字段的加密版本存储在独立的字段（如 `phone_encrypted`、`email_encrypted`）

**优点**:
- 支持按手机号/邮箱查询
- 即使数据库被泄露，敏感信息也不会暴露

**缺点**:
- 明文和加密数据同时存储，需要额外保护数据库访问权限

### 加密算法

- **算法**: AES-256-GCM
- **密钥长度**: 256 位
- **IV 长度**: 12 字节（推荐）
- **认证标签**: 16 字节（自动附加）

### 密钥管理

加密密钥存储在 `encryption_keys` 表中，支持密钥轮换。

**表结构**:
```sql
CREATE TABLE encryption_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_name VARCHAR(100) NOT NULL UNIQUE,
  key_value TEXT NOT NULL,  -- 加密后的密钥（使用 RSA 公钥加密）
  iv TEXT NOT NULL,         -- 加密密钥时使用的 IV
  algorithm VARCHAR(50) DEFAULT 'AES-256-GCM',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

## 配置

### 环境变量

在 `.env` 文件中配置以下变量：

```bash
# 加密配置
ENCRYPTION_ALGORITHM=aes-256-gcm
ENCRYPTION_KEY_NAME=clipsync_default_key

# RSA 密钥（用于加密 AES 密钥）
RSA_PUBLIC_KEY=your_rsa_public_key
RSA_PRIVATE_KEY=your_rsa_private_key
```

### 初始化加密密钥

首次部署时，需要生成加密密钥：

```javascript
import { generateNewKey, generateRSAKeyPair } from './utils/encryption.js';

// 生成 RSA 密钥对（用于加密 AES 密钥）
const rsaKeyPair = generateRSAKeyPair();

// 生成 AES 密钥
const aesKey = generateNewKey();

// 使用 RSA 公钥加密 AES 密钥
const encryptedKey = encryptKeyWithRSA(aesKey, rsaKeyPair.publicKey);

// 存储到数据库
await pool.query(`
  INSERT INTO encryption_keys (key_name, key_value, iv, algorithm, is_active)
  VALUES ('clipsync_default_key', $1, $2, 'AES-256-GCM', true)
`, [encryptedKey, iv]);
```

## 使用方式

### 加密字段

```javascript
import { encryptField } from './utils/encryption.js';

// 加密手机号
const encryptedPhone = encryptField(phone, secretKey);

// 存储到数据库
await pool.query(`
  INSERT INTO users (phone, phone_encrypted)
  VALUES ($1, $2)
`, [phone, encryptedPhone]);
```

### 解密字段

```javascript
import { decryptField } from './utils/encryption.js';

// 从数据库读取
const result = await pool.query(`
  SELECT phone, phone_encrypted FROM users WHERE id = $1
`, [userId]);

// 解密
const decryptedPhone = decryptField(result.rows[0].phone_encrypted, secretKey);

console.log('Decrypted phone:', decryptedPhone);
```

### 批量加解密

```javascript
import { encryptObject, decryptObject } from './utils/encryption.js';

// 批量加密
const data = {
  phone: '+8613812345678',
  email: 'user@example.com',
};

const encryptedData = encryptObject(data, ['phone', 'email'], secretKey);

// 批量解密
const decryptedData = decryptObject(encryptedData, ['phone', 'email'], secretKey);
```

## API 示例

### 用户注册（加密手机号）

**请求**:
```http
POST /api/auth/register
Content-Type: application/json

{
  "phone": "+8613812345678",
  "password": "user_password"
}
```

**处理**:
```javascript
// 后端自动加密手机号
const encryptedPhone = encryptField(phone, secretKey);

// 存储明文和加密版本
await pool.query(`
  INSERT INTO users (phone, phone_encrypted)
  VALUES ($1, $2)
`, [phone, encryptedPhone]);
```

### 用户登录（查询后解密）

**请求**:
```http
POST /api/auth/login
Content-Type: application/json

{
  "phone": "+8613812345678",
  "password": "user_password"
}
```

**处理**:
```javascript
// 使用明文查询
const result = await pool.query(`
  SELECT * FROM users WHERE phone = $1
`, [phone]);

// 返回时解密
const user = result.rows[0];
const decryptedPhone = decryptField(user.phone_encrypted, secretKey);

return {
  ...user,
  phone: decryptedPhone,  // 返回解密后的手机号
};
```

## 数据库迁移

### Version 6 迁移

Version 6 迁移添加了加密字段：

```sql
-- 添加加密字段到 users 表
ALTER TABLE users ADD COLUMN phone_encrypted TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN email_encrypted TEXT DEFAULT '';

-- 添加加密字段到 payment_orders 表
ALTER TABLE payment_orders ADD COLUMN payment_token_encrypted TEXT DEFAULT '';

-- 添加加密字段到 user_subscriptions 表
ALTER TABLE user_subscriptions ADD COLUMN subscription_token_encrypted TEXT DEFAULT '';

-- 创建加密密钥表
CREATE TABLE encryption_keys (
  ...
);
```

**运行迁移**:
```bash
node src/server/src/db/migrate-manager.js migrate
```

## 测试

运行加密测试：

```bash
cd src/server
npm test -- --run tests/crypto.test.js
```

**测试结果**:
- ✓ 加密测试（20/20 通过）

## 安全最佳实践

### 1. 密钥管理

- **定期轮换**: 每 3-6 个月轮换一次加密密钥
- **安全存储**: RSA 私钥应存储在安全的密钥管理系统（如 AWS KMS、HashiCorp Vault）
- **访问控制**: 严格限制加密密钥的访问权限

### 2. 数据库安全

- **透明数据加密（TDE）**: 启用数据库的透明数据加密功能
- **网络隔离**: 数据库不应直接从公网访问
- **审计日志**: 记录所有敏感数据的访问记录

### 3. 应用安全

- **内存清理**: 敏感数据使用后立即从内存中清除
- **最小权限**: 数据库用户应使用最小权限原则
- **输入验证**: 所有用户输入都应进行验证和清理

### 4. 合规要求

- **GDPR**: 用户有权要求删除其个人数据
- **数据导出**: 用户有权导出其个人数据（明文格式）
- **审计追踪**: 记录所有敏感数据的访问和修改记录

## 故障排查

### 解密失败

**错误信息**: `Unsupported state or unable to authenticate data`

**可能原因**:
1. 密钥不正确
2. 加密数据被修改
3. IV 不正确

**解决方法**:
1. 检查使用的密钥是否正确
2. 确认加密数据未被修改
3. 检查 IV 是否正确存储和传递

### 密钥丢失

**风险**: 密钥丢失将导致所有加密数据无法解密

**预防措施**:
1. 备份加密密钥（安全存储）
2. 使用密钥管理系统（KMS）
3. 定期测试密钥恢复流程

## 性能考虑

### 加密开销

- AES-256-GCM 加密/解密速度很快（~100MB/s）
- 主要开销在密钥管理和存储

### 查询性能

- 使用混合方案，查询性能不受影响
- 加密字段仅用于备份和恢复

### 优化建议

1. **连接池**: 使用数据库连接池减少连接开销
2. **缓存**: 缓存解密后的敏感数据（内存缓存，注意安全）
3. **批量操作**: 批量加解密减少函数调用开销

## 生产环境部署

### 密钥管理系统

推荐使用专业的密钥管理系统：
- **AWS KMS**: Amazon Key Management Service
- **Azure Key Vault**: Microsoft Azure Key Vault
- **HashiCorp Vault**: Open-source secret management

### 监控和告警

监控以下指标：
- 加密/解密操作次数
- 加密操作延迟
- 密钥轮换状态
- 解密失败次数

### 灾难恢复

1. **密钥备份**: 定期备份加密密钥
2. **数据备份**: 备份数据库（包括加密数据）
3. **恢复测试**: 定期测试密钥和数据恢复流程

## API 文档

### POST /api/auth/register

注册新用户（自动加密手机号/邮箱）

**请求体**:
```json
{
  "phone": "+8613812345678",
  "password": "user_password"
}
```

**响应**:
```json
{
  "success": true,
  "user": {
    "id": "uuid",
    "phone": "+8613812345678",  // 解密后的手机号
    "nickname": ""
  }
}
```

### POST /api/auth/login

用户登录（自动解密手机号/邮箱）

**请求体**:
```json
{
  "phone": "+8613812345678",
  "password": "user_password"
}
```

**响应**:
```json
{
  "success": true,
  "token": "jwt_token",
  "user": {
    "id": "uuid",
    "phone": "+8613812345678",  // 解密后的手机号
    "email": "user@example.com"  // 解密后的邮箱
  }
}
```

## 参考资料

- [AES-GCM 规范](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf)
- [Node.js crypto 模块](https://nodejs.org/api/crypto.html)
- [OWASP 加密实践](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
