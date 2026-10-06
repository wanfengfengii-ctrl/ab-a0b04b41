# syntax=docker/dockerfile:1

# ---- 构建阶段：含 devDependencies（typescript），verify 服务复用此阶段 ----
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

COPY scripts ./scripts

# ---- 运行阶段：仅含编译产物的精简镜像 ----
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

COPY package.json ./
COPY --from=builder /app/dist ./dist

USER node

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["node", "dist/server.js"]
