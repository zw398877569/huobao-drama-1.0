/**
 * ★ Sprint 41 追加单 177 (PM msg-20261114-177): 视频卡片的【懒加载 + 销毁】
 *
 * 【为什么要改】一页 21 个 <video> 元素 = Chrome 给【每个】建一个独立媒体实例 + 解码器 + 缓冲
 *   → 页面滚动/点播放都卡 (而同样文件下载到本地播完全正常 → 用户以为片子或服务坏了)。
 *
 * ★ 关键不是"懒加载", 是【销毁】: 只做 IntersectionObserver 的话, 21 个元素还是都挂着,
 *   解码器照样占着 → 所以默认【根本不渲染 <video>】, 只渲染封面图 + 播放按钮,
 *   用户点了才把 <video> 挂进去; 播完 / 切 tab / 视频被重新生成 → 把它拆掉。
 *
 * 【激活态怎么记】shotId → 【激活时的视频 URL】。
 *   记 URL 而不是只记 shotId: 视频被重新生成后 URL 变了 → 旧的 <video> 元素该拆,
 *   否则会拿着旧 URL 继续播 (而且用户看到的是过期的那一版)。
 */
import { ref, watch, type Ref } from 'vue'

export interface LazyVideoCardsOptions {
  /** 镜头列表 (刷新后会换引用 → 触发 prune) */
  shots: Ref<any[]>
  /** 该镜的原始视频 URL */
  videoUrlOf: (sb: any) => string | null
  /** 该镜的合成后视频 URL (可选; 传了就优先用它 —— 视频合成 tab 用) */
  composedUrlOf?: (sb: any) => string | null
  /** 切 tab 的标识 (可选; 变了就清空激活态) */
  tabKey?: Ref<any>
}

export function useLazyVideoCards(opts: LazyVideoCardsOptions) {
  /** shotId → 激活时的视频 URL */
  const active = ref<Map<number, string>>(new Map())

  /** 该镜在当前 tab 下要播的视频 URL */
  function urlOf(s: any, preferComposed: boolean): string | null {
    if (preferComposed && opts.composedUrlOf) {
      const c = opts.composedUrlOf(s)
      if (c) return c
    }
    return opts.videoUrlOf(s)
  }

  /** 这个 <video> 元素现在该不该挂着 (URL 一致才算激活) */
  function isActive(s: any, preferComposed: boolean): boolean {
    if (!s) return false
    const url = urlOf(s, preferComposed)
    if (!url) return false
    return active.value.get(s.id) === url
  }

  /** 用户点了播放 → 挂上 <video> */
  function start(s: any, preferComposed: boolean): void {
    if (!s) return
    const url = urlOf(s, preferComposed)
    if (!url) return
    const m = new Map(active.value)
    m.set(s.id, url)
    active.value = m
  }

  /** 播完 / 用户主动收起 → 拆掉 <video> */
  function stop(shotId: number): void {
    if (!active.value.has(shotId)) return
    const m = new Map(active.value)
    m.delete(shotId)
    active.value = m
  }

  /** 列表刷新后: 镜头没了 / 视频被重新生成 (URL 变了) → 拆掉旧的 */
  function prune(): void {
    if (!active.value.size) return
    const m = new Map(active.value)
    for (const [id, url] of m) {
      const sb = opts.shots.value.find((x: any) => x.id === id)
      const cur = sb ? (urlOf(sb, true) || urlOf(sb, false)) : null
      if (!sb || cur !== url) m.delete(id)
    }
    active.value = m
  }

  /** 全部拆掉 (切 tab) */
  function clear(): void {
    active.value = new Map()
  }

  // 列表刷新 (shots 换引用) → 检查有没有该拆的
  watch(() => opts.shots.value, () => { prune() })
  // 切 tab → 之前挂着的全拆掉 (DOM 本身也会被 v-if 销毁, 这里把状态也清掉)
  // ★ 用可选链: TS 不会因为 if 判断而把闭包里的 opts.tabKey 收窄 → TS18048
  if (opts.tabKey) watch(() => opts.tabKey?.value, () => { clear() })

  return { activeVideos: active, isActive, start, stop, prune, clear }
}
