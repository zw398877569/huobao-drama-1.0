import type { Context } from 'hono'

export function success(c: Context, data: any = null) {
  return c.json({ code: 200, data, message: 'success' })
}

export function created(c: Context, data: any = null) {
  return c.json({ code: 201, data, message: 'created' }, 201)
}

export function badRequest(c: Context, message = 'bad request') {
  return c.json({ code: 400, message }, 400)
}

/**
 * ★ Sprint 57 T3 (PM msg-20261123-225): 构建时间戳 → 显示格式 'MM-DD HH:mm' (统一 UTC)
 *   ★ 统一 UTC 的原因: 后端容器时区不一定跟浏览器一致 → 两边都按 UTC 格式化, 显示出来【逐字相同】,
 *     才不会出现"页面 11-23 15:12 / 服务 11-23 07:12"这种看着不一致的假警报。
 */
export function formatBuildStamp(iso?: string | null): string {
  if (!iso) return 'dev'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'dev'
  // ★ 固定按北京时间 (UTC+8) 格式化, 不依赖容器 TZ 也不依赖浏览器时区
  //   → 后端算出来的串和前端算出来的串【逐字相同】(不会出现"页面 15:12 / 服务 07:12"的假不一致)
  const bj = new Date(d.getTime() + 8 * 3600 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}`
}

export function notFound(c: Context, message = 'not found') {
  return c.json({ code: 404, message }, 404)
}

export function serverError(c: Context, message = 'internal error') {
  return c.json({ code: 500, message }, 500)
}

export function now() {
  return new Date().toISOString()
}
