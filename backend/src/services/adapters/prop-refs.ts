/**
 * ★ Sprint 32 (PM msg-20261103-138): 道具图并进【各 provider】的多图参考。
 *
 * 背景: 136 单 (PM msg-20261102-136) 只在 autodl-comfyui 这条路上实现了
 *   『本镜显式关联的道具图 → 进参考图』。其余 5 个 provider (minimax-official /
 *   minimax / vidu / volcengine / agnes) 完全不消费 record.propReferenceImages
 *   → 用户换个视频模型, 道具关联就又白关联了 (半截功能)。
 *
 * 槽位规则跟 136 单【完全一致】(PM 拍板, QA 已独立验证过 autodl 那版):
 *   · 【首帧必须占第一个参考图位】→ 道具图一律【追加在末尾】
 *     (插前面会把已有参考图整体后移 → prompt 里 <Picture N> 编号错位 →
 *      H3 的 subject_definitions 段里就有 <Picture N> 引用 → 人物身份漂移)
 *   · 已经在参考图里的道具图【不重复追加】(同一张图发两遍浪费槽位)
 *   · 超上限时优先丢【普通参考图】给道具图腾位; index 0 (首帧) 永不删
 *     (宁可砍道具图也不砍首帧 —— 首帧是画面连续性的地基)
 *
 * ★ 取数不在这里做 —— 136 单已经在 services/video-generation.ts 里实现了
 *   resolveStoryboardPropReferenceImages (只认用户显式关联 / 查表失败不阻塞),
 *   各 provider 直接复用 record.propReferenceImages, 不各写一份。
 */
import { logTaskProgress } from '../../utils/task-logger.js'

export interface PropRefItem {
  url: string
  name: string
}

/** 道具图落在第几个参考图位 (0-based) */
export interface PropRefSlot {
  name: string
  slot: number
}

/**
 * 把本镜显式关联的道具图并进参考图列表 (末尾追加)。
 *
 * @param refs       现有的参考图列表 (第 0 位通常是首帧)
 * @param propRefs   本镜显式关联的道具图
 * @param maxImages  该 provider 的参考图数量上限 (Infinity = 不限)
 */
export function mergePropRefsIntoSlots(
  refs: string[],
  propRefs: PropRefItem[],
  maxImages: number,
): { refs: string[]; propSlots: PropRefSlot[]; dropped: string[] } {
  type Slot = { url: string; isProp: boolean; name?: string }
  const slots: Slot[] = (refs || []).map(url => {
    const p = (propRefs || []).find(x => x.url === url)
    return p ? { url, isProp: true, name: p.name } : { url, isProp: false }
  })
  // 不在 refs 里的道具图 → 追加到末尾
  for (const p of propRefs || []) {
    if (!p?.url || !p.name) continue
    if (slots.some(s => s.url === p.url)) continue
    slots.push({ url: p.url, isProp: true, name: p.name })
  }
  const dropped: string[] = []
  const MAX = maxImages && maxImages > 0 ? maxImages : Number.MAX_SAFE_INTEGER
  // 超上限 → 优先丢普通参考图给道具图腾位 (index 0 = 首帧, 永不删)
  for (let i = slots.length - 1; i >= 0 && slots.length > MAX; i--) {
    if (i === 0) continue
    if (slots[i]!.isProp) continue
    dropped.push(slots[i]!.url)
    slots.splice(i, 1)
  }
  // 还是超 (全是道具图) → 砍掉末尾的
  if (slots.length > MAX) {
    for (const s of slots.slice(MAX)) dropped.push(s.url)
    slots.length = MAX
  }
  const propSlots: PropRefSlot[] = []
  slots.forEach((s, i) => { if (s.isProp && s.name) propSlots.push({ name: s.name, slot: i }) })
  return { refs: slots.map(s => s.url), propSlots, dropped }
}

/**
 * prompt 里说明每张道具图是干嘛的 —— 不说明的话模型不知道这张图是道具参考,
 * 会当成又一个人物/场景。编号 = 槽位 + 1 (与 H3 约定 <Picture N> = ref_image_{N-1} 一致)。
 */
export function buildPropRefNotes(propSlots: PropRefSlot[]): string {
  return (propSlots || [])
    .map(sl => `Image ${sl.slot + 1} is the ${sl.name} prop reference and governs its on-screen appearance.`)
    .join('\n')
}

/**
 * 参考图清单进 flow-log —— 事后能核对『这次到底发了哪几张、分别是什么、道具图排第几』。
 * 各 provider 统一用这个 (scope 传 provider 名)。
 */
export function logPropRefSlots(
  provider: string,
  record: any,
  total: number,
  propSlots: PropRefSlot[],
  dropped: string[] = [],
): void {
  logTaskProgress('VideoTask', 'video-ref-slots', {
    provider,
    videoGenId: record?.id,
    storyboardId: record?.storyboardId,
    referenceMode: record?.referenceMode,
    total,
    propCount: propSlots.length,
    slots: propSlots.map(sl => ({ slot: sl.slot, isProp: true, name: sl.name })),
    droppedRefs: dropped,
    hint: '槽位清单: 道具图排在末尾, 首帧仍是第 1 位 (ref_image_0 / 第 1 张参考图)',
  })
}
