# ── Build-time mirror configuration ──────────────────────────────────────
# Defaults to TUNA (China) so plain `docker build` is fast out of the box.
# Both args accept an empty string to fall back to official sources:
#   docker build --build-arg APT_MIRROR= --build-arg NPM_REGISTRY= -t huobao-drama .
#
# The APT_MIRROR is set as the FIRST source; APT automatically falls back to
# Aliyun / Tencent if the primary is unreachable. Order:
#   1. APT_MIRROR       (default: https://mirrors.tuna.tsinghua.edu.cn) — user-chosen
#   2. Aliyun           (https://mirrors.aliyun.com) — second CDN
#   3. Tencent          (https://mirrors.cloud.tencent.com) — last-resort
ARG APT_MIRROR=https://mirrors.tuna.tsinghua.edu.cn
ARG NPM_REGISTRY=https://registry.npmmirror.com

# ── Stage 1: Build frontend ──────────────────────────────────
FROM node:24-slim AS frontend-build

# Re-declare ARGs (Docker ARG scope is per-stage, unless pre-declared)
ARG NPM_REGISTRY
ENV NPM_CONFIG_REGISTRY=$NPM_REGISTRY

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run generate

# ── Stage 2: Build backend native modules ────────────────────
FROM node:24-slim AS backend-build

ARG NPM_REGISTRY
ENV NPM_CONFIG_REGISTRY=$NPM_REGISTRY
ARG APT_MIRROR
# Conditional mirror switch: replace official deb.debian.org with user-provided mirror
# (only runs if APT_MIRROR is non-empty, so default behavior is unchanged)
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s#https://deb.debian.org/debian#$APT_MIRROR/debian https://mirrors.aliyun.com/debian https://mirrors.cloud.tencent.com/debian#g" /etc/apt/sources.list.d/debian.sources ; \
    fi && \
    apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./

# Production deps only (native modules compiled here)
RUN npm ci --omit=dev

# ── Stage 3: Production image (lean) ────────────────────────
FROM node:24-slim

ARG NPM_REGISTRY
ENV NPM_CONFIG_REGISTRY=$NPM_REGISTRY
ARG APT_MIRROR

# ffmpeg (runtime) + tsx (runs TS directly)
# Sprint 23 Task F (PM msg-20261027-095 决策 6/10): 装 fontconfig + fonts-noto-cjk。
#   原因: QA msg-20261024-081 的 P0 —— 容器镜像没装任何中文字体, libass 渲染中文全是豆腐块,
#   【中文字幕从来没成功渲染过一次】(历史上一直 fallback)。
#   ⚠️ fontconfig 必须一起装 —— libass 是通过 fontconfig 发现系统字体的, 光有字体文件它认不出来。
#   ⚠️ 显式 fc-cache -f —— 装包 postinst 会跑, 但 node:24-slim 里可能静默跳过 → 缓存没生成 → 仍然找不到字体。
#   fc-list 那行只是把 family name / 安装路径打进 CI 构建日志, 供验收时核对, 失败也不会让构建挂掉 (head 兜底)。
# Same conditional mirror switch — saves 5-10 min on China builds by avoiding deb.debian.org
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s#https://deb.debian.org/debian#$APT_MIRROR/debian https://mirrors.aliyun.com/debian https://mirrors.cloud.tencent.com/debian#g" /etc/apt/sources.list.d/debian.sources ; \
    fi && \
    apt-get update && apt-get install -y --no-install-recommends ffmpeg sqlite3 \
    fontconfig fonts-noto-cjk \
    && fc-cache -f \
    && echo "--- noto cjk fonts (给 QA 核对 family name / 实际安装路径) ---" \
    && fc-list | grep -i 'noto sans cjk' | head -3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm i -g tsx

WORKDIR /app

# Pre-built node_modules (production only, native modules ready)
COPY --from=backend-build /app/backend/node_modules ./backend/node_modules
COPY backend/package.json backend/package-lock.json ./backend/

# Backend source
COPY backend/src ./backend/src
COPY backend/tsconfig.json ./backend/

# Migrations (manual SQL + .ts runner scripts) — production image needs these so users can run `docker exec ... sh -c "sqlite3 /app/data/huobao_drama.db < /app/backend/migrations/manual-*.sql"` directly without docker cp
COPY backend/migrations ./backend/migrations

# Frontend static output
COPY --from=frontend-build /app/frontend/.output/public ./frontend/dist

# Skills
COPY skills/ ./skills/

# Config
COPY configs/config.example.yaml ./configs/config.yaml

RUN mkdir -p data/static

ENV NODE_ENV=production
ENV PORT=5679
# Sprint 10 fix: 容器 timezone 设 Asia/Shanghai, 让 new Date() / logTask* 输出本地时间
ENV TZ=Asia/Shanghai

EXPOSE 5679
VOLUME ["/app/data"]

CMD ["tsx", "backend/src/index.ts"]
