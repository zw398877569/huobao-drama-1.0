/**
 * ★ Sprint 56 (PM msg-20261123-224): 本地 dev server 的代理目标解析
 *
 * 背景: 开发机从 Intel Mac 换成 M3 之后, 前端本地起不来 / 拿不到数据 ——
 *   vite dev server 把 /api 和 /static 转发到写死的 http://localhost:5679,
 *   但 M3 本机没有后端容器 → 页面上所有接口都拿不到东西, 没法联调。
 *
 * 规则 (★ 硬约束):
 *   ① 默认值 = http://localhost:5679 —— ★ 一字不变
 *      (Win host / Intel Mac 上后端就在 localhost, 那两台的行为完全不变)
 *   ② 换机时用【不入库的】frontend/.env.local 指定:
 *        HUOBAO_API_PROXY_TARGET=http://<后端局域网IP>:5679
 *      仓库里【不允许】出现具体 IP (只有本地配置文件里可以有)。
 *   ③ 只影响本地 dev (vite.server.proxy); 生产构建走相对路径 '/api/v1', 不受影响。
 *   ④ '/api' 与 '/static' 两项都要跟着变 —— 角色形象图 / 配音 mp3 都走 /static,
 *      只改 /api 会出现"页面有数据但图裂了"。
 *   ⑤ 优先级: 进程环境变量 > .env.local > 默认值
 *      (由 vite 的 loadEnv 保证: 它返回的 env 里 process.env 覆盖文件值)
 */

/** 默认代理目标 —— ★ 一字不改 (Win host / Intel Mac 的后端都在 localhost) */
export const DEFAULT_PROXY_TARGET = 'http://localhost:5679'

/** 环境变量名 (前端 dev 专用) */
export const PROXY_TARGET_ENV_KEY = 'HUOBAO_API_PROXY_TARGET'

export interface ResolvedProxyTarget {
  target: string
  /** 目标来自哪里 (便于日志 / 离线断言) */
  source: 'env' | 'default'
}

/**
 * 解析 dev 代理目标 —— ★ 纯函数 (入参 → 出参, 无副作用, 可离线断言)
 * @param env vite loadEnv() 的返回值 (已含 process.env, 且 process.env 优先)
 */
export function resolveProxyTarget(env: Record<string, string | undefined> = {}): ResolvedProxyTarget {
  const value = (env?.[PROXY_TARGET_ENV_KEY] || '').trim()
  if (value) return { target: value, source: 'env' }
  return { target: DEFAULT_PROXY_TARGET, source: 'default' }
}
