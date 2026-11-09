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
 * ★ Sprint 36 追加 (PM msg-20261107-159): 本镜【有没有首尾帧】→ 决定视频层要不要带道具图。
 *
 * 【为什么】mode=first_last 时, 首/尾帧本来就是【带着道具图生成的】(帧层 collectShotPropAssets 不动)
 *   → 道具在帧里已经定型; 视频模型再收到一张【独立的】道具产品照 = 多画一个实物 = 穿模。
 *   实测 drama19/ep20 镜#3: 视频里出现两个保温箱, 其中一个还跟身体相交。
 *
 * 【口径】判据是【帧在不在】(referenceMode / 有没有 firstFrameUrl·lastFrameUrl),
 *   【不是】『镜头文本有没有提到这个道具』—— 文本只是代理指标, 帧才是真相
 *   (用户关联了道具时, 帧的参考图里本来就有它)。
 *
 * 【保留】mode=multiple / single (纯多图, 没有首尾帧) → 道具图【照旧进槽位】:
 *   这条路线没有帧, 道具图是唯一的权威参考, 删了道具在视频里会失控/变形。
 */
export function hasFrameRefs(record: any): boolean {
  if (!record) return false
  if (record.referenceMode === 'first_last') return true
  return !!record.firstFrameUrl || !!record.lastFrameUrl
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
  record?: any,
): { refs: string[]; propSlots: PropRefSlot[]; dropped: string[] } {
  // ★ Sprint 36 追加 (PM msg-20261107-159): 有首尾帧 → 道具图【不进】视频参考图 (见 hasFrameRefs)。
  //   道具在帧里已经定型, 再喂一张独立产品照 = 模型多画一个实物 (穿模)。
  const skipProps = hasFrameRefs(record)
  const effectivePropRefs = skipProps ? [] : (propRefs || [])
  if (skipProps && (propRefs || []).length) {
    logTaskProgress('VideoTask', 'prop-refs-skipped-for-frames', {
      storyboardId: record?.storyboardId,
      referenceMode: record?.referenceMode,
      propCount: propRefs.length,
      props: propRefs.map(p => p?.name).filter(Boolean),
      hint: '本镜有首尾帧 → 道具在帧里已定型, 视频层不再喂独立道具图 (否则会多画一个实物/穿模)',
    })
  }
  type Slot = { url: string; isProp: boolean; name?: string }
  const slots: Slot[] = (refs || []).map(url => {
    const p = effectivePropRefs.find(x => x.url === url)
    return p ? { url, isProp: true, name: p.name } : { url, isProp: false }
  })
  // 不在 refs 里的道具图 → 追加到末尾
  for (const p of effectivePropRefs) {
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
