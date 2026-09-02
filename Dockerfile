# ── Build-time mirror configuration ──────────────────────────────────────
# Defaults to Aliyun (China) so plain `docker build` is fast out of the box.
# Both args accept an empty string to fall back to official sources:
#   docker build --build-arg APT_MIRROR= --build-arg NPM_REGISTRY= -t huobao-drama .
#
# The APT_MIRROR is set as the FIRST source; APT automatically falls back to
# Tencent / TUNA / deb.debian.org if the primary is unreachable. Order:
#   1. APT_MIRROR       (default: mirrors.aliyun.com) — user-chosen
#   2. Tencent          (mirrors.cloud.tencent.com) — second CDN
#   3. TUNA             (mirrors.tuna.tsinghua.edu.cn) — academic, less likely
#                         to be intercepted by corporate proxies
#   4. deb.debian.org   — official source, works for users with proxy access
ARG APT_MIRROR=mirrors.aliyun.com
ARG NPM_REGISTRY=https://registry.npmmirror.com

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run generate

# ── Stage 2: Build backend native modules ────────────────────
FROM node:20-slim AS backend-build

ARG NPM_REGISTRY
ENV NPM_CONFIG_REGISTRY=$NPM_REGISTRY
ARG APT_MIRROR
# Conditional mirror switch: replace official deb.debian.org with user-provided mirror
# (only runs if APT_MIRROR is non-empty, so default behavior is unchanged)
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|deb.debian.org|$APT_MIRROR https://mirrors.cloud.tencent.com/debian https://mirrors.tuna.tsinghua.edu.cn/debian https://deb.debian.org/debian|g" /etc/apt/sources.list.d/debian.sources ; \
    fi && \
    apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./

# Production deps only (native modules compiled here)
RUN npm ci --omit=dev

# ── Stage 3: Production image (lean) ────────────────────────
FROM node:20-slim

ARG NPM_REGISTRY
ENV NPM_CONFIG_REGISTRY=$NPM_REGISTRY
ARG APT_MIRROR

# ffmpeg (runtime) + tsx (runs TS directly)
# Same conditional mirror switch — saves 5-10 min on China builds by avoiding deb.debian.org
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|deb.debian.org|$APT_MIRROR https://mirrors.cloud.tencent.com/debian https://mirrors.tuna.tsinghua.edu.cn/debian https://deb.debian.org/debian|g" /etc/apt/sources.list.d/debian.sources ; \
    fi && \
    apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && npm i -g tsx

WORKDIR /app

# Pre-built node_modules (production only, native modules ready)
COPY --from=backend-build /app/backend/node_modules ./backend/node_modules
COPY backend/package.json backend/package-lock.json ./backend/

# Backend source
COPY backend/src ./backend/src
COPY backend/tsconfig.json ./backend/

# Frontend static output
COPY --from=frontend-build /app/frontend/.output/public ./frontend/dist

# Skills
COPY skills/ ./skills/

# Config
COPY configs/config.example.yaml ./configs/config.yaml

RUN mkdir -p data/static

ENV NODE_ENV=production
ENV PORT=5679

EXPOSE 5679
VOLUME ["/app/data"]

CMD ["tsx", "backend/src/index.ts"]
