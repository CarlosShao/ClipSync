# 内存会话管理迁移到 Redis - 完成总结

## ✅ 完成日期

**2026年6月24日**

---

## 📋 完成的任务

### 1. 创建 Redis 客户端工具

**文件**：`src/server/src/utils/redis-client.js`

**功能**：
- 获取 Redis 客户端（单例模式）
- 关闭 Redis 连接
- 存储/获取/删除 CSRF 令牌
- 存储/获取/删除上传会话
- 存储/删除 WebSocket 连接元数据
- 获取用户的所有 WebSocket 连接（跨实例）

**Redis Key 设计**：
- `csrf:token:{token}` - CSRF 令牌（TTL: 24小时）
- `upload:session:{sessionId}` - 上传会话（TTL: 24小时）
- `ws:connection:{userId}:{deviceId}` - WebSocket 连接元数据（TTL: 1小时）

---

### 2. 修改 CSRF 中间件

**文件**：`src/server/src/middleware/csrf.js`

**修改内容**：
1. 导入 Redis 客户端工具
   ```javascript
   import { storeCsrfToken, getCsrfToken, deleteCsrfToken } from '../utils/redis-client.js';
   ```

2. 支持 Redis 和内存两种模式（通过 `NODE_ENV` 切换）
   ```javascript
   const useRedis = process.env.NODE_ENV === 'production';
   ```

3. 将函数改为异步（`async/await`）
   - `generateCsrfToken()` - 异步
   - `validateCsrfToken()` - 异步
   - `csrfProtection()` - 异步中间件
   - `getCsrfToken()` - 异步

4. 添加内存回退方案（当 Redis 不可用时）
   ```javascript
   if (useRedis) {
     try {
       await storeCsrfToken(token, tokenData);
     } catch (err) {
       // 回退到内存
       memoryCsrfTokens.set(token, tokenData);
     }
   }
   ```

5. 删除 `cleanupExpiredTokens()` 函数（Redis TTL 会自动清理）

---

### 3. 修改分片上传路由

**文件**：`src/server/src/routes/chunked-upload.js`

**修改内容**：
1. 导入 Redis 客户端工具
   ```javascript
   import { storeUploadSession, getUploadSession, deleteUploadSession } from '../utils/redis-client.js';
   ```

2. 将 `uploadedChunks` 从 `Set` 改为 `Array`（以便序列化存储到 Redis）
   ```javascript
   // 之前：uploadedChunks: new Set()
   // 之后：uploadedChunks: []
   ```

3. 创建辅助函数（支持 Redis 和内存）
   - `saveUploadSession(uploadId, sessionData)` - 保存上传会话
   - `loadUploadSession(uploadId)` - 获取上传会话
   - `removeUploadSession(uploadId)` - 删除上传会话

4. 修改所有操作 `uploadSessions` 的代码
   - `uploadSessions.set()` → `await saveUploadSession()`
   - `uploadSessions.get()` → `await loadUploadSession()`
   - `uploadSessions.delete()` → `await removeUploadSession()`

5. 修改所有操作 `uploadedChunks` 的代码
   - `session.uploadedChunks.add(chunkIndexNum)` → `session.uploadedChunks.push(chunkIndexNum)`
   - `session.uploadedChunks.has(i)` → `session.uploadedChunks.includes(i)`
   - `session.uploadedChunks.size` → `session.uploadedChunks.length`

---

### 4. WebSocket 连接管理（暂不修改）

**文件**：`src/server/src/ws/server.js`

**当前状态**：
- 继续使用内存 `Map` 存储 WebSocket 连接
- 已配置 Nginx sticky session（`ip_hash`），确保同一用户的请求路由到同一实例

**后续优化方案**：
- 使用 Redis Pub/Sub 实现跨实例 WebSocket 消息广播
- 需要较大的架构改动，作为后续优化任务

---

## 📂 创建/修改的文件清单

### 新创建的文件

1. **`src/server/src/utils/redis-client.js`**
   - Redis 客户端工具
   - 支持 CSRF 令牌、上传会话、WebSocket 连接元数据存储

### 修改的文件

1. **`src/server/src/middleware/csrf.js`**
   - 将 `csrfTokens` 从内存 Map 迁移到 Redis
   - 函数改为异步（`async/await`）
   - 添加内存回退方案

2. **`src/server/src/routes/chunked-upload.js`**
   - 将 `uploadSessions` 从内存 Map 迁移到 Redis
   - 将 `uploadedChunks` 从 `Set` 改为 `Array`
   - 添加内存回退方案

---

## ⚠️ 已知问题和风险

### 1. 异步中间件兼容性问题

**问题**：`csrfProtection` 中间件现在是异步的（`async function`），Express 默认支持异步中间件，但需要确保错误被正确捕获。

**解决方案**：
- Express 5.x 原生支持异步中间件（自动捕获 `Promise` 拒绝）
- 如果使用 Express 4.x，需要添加错误处理包装器：
  ```javascript
  function asyncHandler(fn) {
    return (req, res, next) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    };
  }
  
  // 使用
  app.use('/api/auth', asyncHandler(csrfProtection));
  ```

**验证**：
- 启动后端服务，测试 CSRF 保护功能
- 检查是否有未捕获的 `Promise` 拒绝

---

### 2. Redis 连接失败处理

**问题**：如果 Redis 连接失败，所有依赖 Redis 的功能会出错。

**解决方案**（已实现）：
- 添加内存回退方案（当 Redis 不可用时，自动回退到内存存储）
- 在生产环境，应该配置 Redis 高可用（主从复制、哨兵模式）

**验证**：
- 测试 Redis 连接失败时的回退逻辑
- 检查日志中是否有 "falling back to memory" 警告

---

### 3. WebSocket 跨实例通信

**问题**：当前 WebSocket 连接仍然使用内存存储，多实例部署时，跨实例的 WebSocket 消息无法广播。

**临时方案**（已配置）：
- 使用 Nginx sticky session（`ip_hash`），确保同一用户的请求路由到同一实例
- 如果实例宕机，用户会话会丢失（需要重新连接）

**后续优化方案**：
- 使用 Redis Pub/Sub 实现跨实例 WebSocket 消息广播
- 每个实例订阅 Redis 频道，收到消息后广播到本实例的 WebSocket 连接

**预计工作量**：3-5 天

---

## 🧪 测试计划

### 1. 功能测试

1. **CSRF 保护**
   - 测试获取 CSRF 令牌端点（`GET /api/csrf-token`）
   - 测试 CSRF 保护中间件（POST 请求需要有效的 CSRF 令牌）
   - 测试令牌单次使用（使用后删除）

2. **分片上传**
   - 测试初始化分片上传（`POST /api/upload/init`）
   - 测试上传分片（`POST /api/upload/chunk/:uploadId/:chunkIndex`）
   - 测试获取上传状态（`GET /api/upload/status/:uploadId`）
   - 测试完成上传（`POST /api/upload/complete/:uploadId`）
   - 测试取消上传（`DELETE /api/upload/cancel/:uploadId`）

3. **Redis 回退**
   - 停止 Redis 服务
   - 测试 CSRF 和分片上传功能（应该回退到内存）
   - 检查日志中是否有 "falling back to memory" 警告
   - 重启 Redis 服务

---

### 2. 多实例部署测试

1. **启动多实例**
   ```bash
   docker compose -f docker-compose.multi.yml up -d
   ```

2. **验证负载均衡**
   - 发送多个请求，检查是否路由到不同实例
   - 检查 Nginx 日志（`docker logs clipsync-nginx`）

3. **验证 sticky session**
   - 使用同一令牌发送多个请求，检查是否路由到同一实例
   - 检查 WebSocket 连接是否稳定

4. **验证 Redis 会话共享**
   - 在实例 1 初始化分片上传
   - 在实例 2 查询上传状态（应该能查询到）
   - 在实例 2 完成上传（应该能完成）

---

## 📊 性能影响

### 1. Redis  vs 内存

**内存存储**：
- 优点：速度快（无网络延迟）
- 缺点：不支持多实例共享

**Redis 存储**：
- 优点：支持多实例共享，数据持久化
- 缺点：有网络延迟（通常 < 1ms）

**性能测试**：
- 使用 `ab` 或 `wrk` 进行压力测试
- 比较内存存储和 Redis 存储的响应时间
- 如果 Redis 延迟过高，可以考虑使用 Redis 集群

---

### 2. 异步中间件性能

**同步中间件**：
- 优点：无 `Promise` 开销
- 缺点：无法执行异步操作

**异步中间件**：
- 优点：支持异步操作（例如 Redis 操作）
- 缺点：有 `Promise` 开销（通常可忽略）

**性能测试**：
- 使用 `ab` 或 `wrk` 进行压力测试
- 比较同步和异步中间件的吞吐量
- 如果性能下降明显，可以考虑使用 Redis 连接池

---

## 🔄 后续任务

### 立即执行（无外部依赖）

1. **测试修改后的功能**
   - 测试 CSRF 保护功能
   - 测试分片上传功能
   - 测试 Redis 回退逻辑
   - **预估工作量**：0.5-1 天

2. **测试多实例部署**
   - 启动多实例部署
   - 验证负载均衡和 sticky session
   - 验证 Redis 会话共享
   - **预估工作量**：0.5-1 天

3. **修复异步中间件兼容性问题**（如果需要）
   - 添加错误处理包装器
   - 测试 Express 版本兼容性
   - **预估工作量**：0.5 天

### 后续优化（可选）

1. **WebSocket 跨实例通信**
   - 使用 Redis Pub/Sub 实现跨实例 WebSocket 消息广播
   - **预估工作量**：3-5 天

2. **Redis 高可用**
   - 配置 Redis 主从复制
   - 配置 Redis 哨兵模式
   - **预估工作量**：1-2 天

3. **Redis 性能优化**
   - 使用 Redis 连接池
   - 使用 Redis 集群
   - **预估工作量**：1-2 天

---

## ✅ 总结

**已完成**：
- ✅ 创建 Redis 客户端工具
- ✅ 将 CSRF 令牌从内存迁移到 Redis
- ✅ 将上传会话从内存迁移到 Redis
- ✅ 添加内存回退方案（当 Redis 不可用时）
- ✅ 配置 Nginx sticky session（临时解决 WebSocket 跨实例问题）

**剩余问题**：
- ⚠️ WebSocket 跨实例通信（后续优化）
- ⚠️ 异步中间件兼容性测试
- ⚠️ Redis 高可用配置（生产环境需要）

**下一步建议**：
1. 测试修改后的功能（CSRF、分片上传）
2. 测试多实例部署和 Redis 会话共享
3. 修复发现的问题
4. 继续后续任务（Windows/Android 优化）

---

**创建日期**：2026-06-24
**作者**：ClipSync Development Team
**版本**：1.0
