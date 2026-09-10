# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# AN-06：postgresql-client（pg_dump）——手动备份 trigger_backup 依赖
RUN apk add --no-cache postgresql-client

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev for build)
RUN npm ci

# Copy source code
COPY . .

# Production stage
FROM node:22-alpine

# Install wget for healthcheck + postgresql-client (AN-06: pg_dump for trigger_backup)
RUN apk add --no-cache wget postgresql-client

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

# Create upload directories
RUN mkdir -p uploads/images/thumbnails uploads/files && \
    chown -R clipsync:clipsync /app

USER clipsync

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/health || exit 1

# Start server
CMD ["node", "src/index.js"]
