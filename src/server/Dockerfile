# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# AN-06：postgresql-client（pg_dump）——手动备份 trigger_backup 依赖
# font-wqy-zenhei：中文字体（wqy-zenhei.ttc）——utils/pdf-invoice.js 用 pdfkit 生成
#   发票 PDF，pdfkit 的标准 14 字体走 WinAnsi 编码，**画不出一个中文字**，
#   必须嵌一款含 CJK 字形的 TrueType。实测该包落盘路径：
#     /usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc（注意不是 Debian 的 truetype/wqy）
#   且它是 TTC 集合，pdfkit 第二个参数要传 postscript 名 `WenQuanYiZenHei`
#   （fontkit 按 postscriptName 精确匹配，传 "WenQuanYi Zen Hei" 会报 not found in collection）。
#   builder 与 runtime 两个 stage 都要装：docker-compose.dev.yml 跑的是 builder 目标。
RUN apk add --no-cache postgresql-client font-wqy-zenhei

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev for build)
RUN npm ci

# Copy source code
COPY . .

# Production stage
FROM node:22-alpine

# Install wget for healthcheck + postgresql-client (AN-06: pg_dump for trigger_backup)
# + font-wqy-zenhei（发票 PDF 中文字体，理由见 builder stage 注释）。
#   生产 stage 漏装的后果：/api/invoices/:id/download 生成 PDF 时抛「未找到中文字体」→ 500。
RUN apk add --no-cache wget postgresql-client font-wqy-zenhei

# Create non-root user
RUN addgroup -g 1001 -S clipsync && \
    adduser -S clipsync -u 1001 -G clipsync

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# Copy source from builder
COPY --from=builder /app/src ./src

# 静态法务页（隐私政策/服务协议等）——index.js 以 ../views 与 ../public 挂载。
# 不 COPY 则生产镜像内这两个目录不存在，法务页全部 404
# （国内应用商店上架要求隐私政策必须有可访问 URL）。
COPY --from=builder /app/views ./views
COPY --from=builder /app/public ./public

# 跨端共享模块（src/shared）——server 侧（routes/auth.js、utils/pdf-invoice.js）
# 以 ../../../shared/domains.js 引用，容器内解析为 /shared/domains.js，
# 故必须落在镜像根的 /shared。
# 构建上下文是 ./src/server，够不到仓库根的 src/shared，
# 因此 compose 用 additional_contexts 把该目录传进来（见 docker-compose.prod.yml）。
# 缺这一步的后果：api 容器启动即 ERR_MODULE_NOT_FOUND 崩溃重启
# （2026-09-15 生产部署实测踩到）。
COPY --from=shared . /shared

# Create upload directories
RUN mkdir -p uploads/images/thumbnails uploads/files && \
    chown -R clipsync:clipsync /app

USER clipsync

# Expose port
# 注意：compose 的 docker-compose.prod.yml 显式设 PORT=3000，
# 故此处必须与之一致——曾因 Dockerfile 写 3001 而 compose 用 3000，
# 导致 HEALTHCHECK 恒失败（容器显示 unhealthy 但接口实际正常）。
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Start server
CMD ["node", "src/index.js"]
