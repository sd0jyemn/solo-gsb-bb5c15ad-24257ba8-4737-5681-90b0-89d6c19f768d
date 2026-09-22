# syntax=docker/dockerfile:1

# —— 构建阶段 ——
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# better-sqlite3 优先下载预编译二进制；
# 若构建环境无法访问 GitHub release，则回退 node-gyp 源码编译，故同时备好工具链。
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# 运行时只保留生产依赖
RUN npm prune --omit=dev

# —— 运行阶段 ——
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/data/cache-lab.db \
    LOG_LEVEL=info

# tini 负责信号转发与僵尸进程回收；ca-certificates 供回源场景使用
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/src/index.js"]
