// ★ vite 由 nuxt 直接依赖 (nuxt.config 里用它的 loadEnv 读 .env / .env.local 是常规用法)
// ★ 刻意【不用】node 内置模块 (node:fs / node:path / process) —— 前端 tsconfig 的 types 是空的,
//   没有 @types/node, 用 node API 会新增 vue-tsc 错误 (本单验收要求"不新增错误")
import { loadEnv } from 'vite'
import { resolveProxyTarget } from './utils/proxy-target'

/**
 * ★ Sprint 56 (PM msg-20261123-224): 本地 dev server 的代理目标【可配置】
 *   - 默认值 http://localhost:5679 一字不变 (Win host / Intel Mac 上后端就在 localhost)
 *   - 换开发机 (M3) 时用【不入库的】frontend/.env.local 覆盖:
 *       HUOBAO_API_PROXY_TARGET=http://<后端局域网IP>:5679
 *   - ★ 只影响本地 dev (vite.server.proxy); 生产构建走相对路径 '/api/v1', 不受影响
 */
// ★ loadEnv 会读 .env / .env.local (与 mode 无关), 并把 process.env 合并进来 (process.env 优先)
//   envDir 用相对路径 → 不用 node:path: cwd=frontend/ 时读 ./.env.local; cwd=仓库根 时读 frontend/.env.local
const devProxyEnv = {
  ...loadEnv('development', 'frontend', ''),
  ...loadEnv('development', '.', ''),
}
const { target: devProxyTarget, source: devProxyTargetSource } = resolveProxyTarget(devProxyEnv)
if (devProxyEnv.NODE_ENV !== 'production') {
  console.log(`[dev-proxy] /api 与 /static 的代理目标 = ${devProxyTarget} (来源: ${devProxyTargetSource})`)
}

/**
 * ★ Sprint 57 T3 (PM msg-20261123-225): 构建版本标识注入前端产物
 *   (与后端 /health 返回的 buildId 比对 → 页面是不是旧版本一眼可见)
 *   ★ BUILD_ID / BUILD_TIME 由 Docker 构建时注入 (Dockerfile ARG → ENV, CI 传 --build-arg)
 *   ★ 格式化与后端 formatBuildStamp 逐字一致 (固定北京时间 UTC+8, 不依赖容器/浏览器时区)
 */
function formatBuildStamp(iso?: string): string {
  if (!iso) return 'dev'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'dev'
  const bj = new Date(d.getTime() + 8 * 3600 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}`
}
const buildId = String(devProxyEnv.BUILD_ID || 'dev')
const buildTime = formatBuildStamp(devProxyEnv.BUILD_TIME)

export default defineNuxtConfig({
  runtimeConfig: {
    public: {
      buildId,
      buildTime,
    },
  },
  srcDir: 'app/',
  ssr: false,
  devtools: { enabled: false },
  experimental: {
    appManifest: false,
  },
  app: {
    head: {
      title: '火宝短剧',
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
      link: [
        { rel: 'icon', type: 'image/png', href: '/favicon.png' },
        { rel: 'shortcut icon', type: 'image/png', href: '/favicon.png' },
      ],
    },
  },
  vite: {
    server: {
      proxy: {
        // ★ Sprint 56: 两项都指向同一个可配置目标 (只改 /api 会出现"页面有数据但图裂了")
        '/api': { target: devProxyTarget, changeOrigin: true },
        '/static': { target: devProxyTarget, changeOrigin: true },
      },
    },
  },
  compatibilityDate: '2025-05-15',
})
