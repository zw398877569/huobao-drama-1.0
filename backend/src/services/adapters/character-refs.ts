/**
 * ★ Sprint 52 (PM msg-20261117-207): minimax_h3_803 注入【角色形象图】作额外参考图
 *
 * 【为什么是 803 专属】
 *   803 = H3九图三音15s(画质增强版), 平台侧支持 ref_image_0~8 (9 张) + ref_audio_0~2。
 *   而本项目现在只喂【首帧 + 尾帧】两张 → 7 个槽位一直空着, 803 的"九图"能力等于关着。
 *   ★ 只对 workflowId === 'minimax_h3_803' 且 reference_mode === 'first_last' 生效:
 *     其它工作流 / multiple / single / T2V / FL2V 一律走原路径 (请求体逐字不变)。
 *
 * 【槽位铁律】
 *   · ref_image_0 = 首帧, ref_image_1 = 尾帧 —— 【不动】(插前面会让 prompt 里的编号整体错位 → 人物身份漂移)
 *   · 角色形象图追加在 slot 2 起, 按 <Subject N> 升序
 *   · 总数上限 9 张 (平台硬上限), 超出的丢弃并记 flow-log
 *
 * 【为什么 prompt 里必须点名】
 *   H3 的 subject_definitions 写的是 "derived from the opening frame" (FL2V 语义, 首尾帧模式下不用 <Picture N>
 *   指代人物)。加了角色立绘后模型不知道那张立绘是谁 → 不点名的后果是【多出人 / 换脸 / 串角色】。
 *   ★ 命名句用 "Image N" 指代 (不用 <Picture N> —— 首尾帧模式下 <Picture N> 指的是首/尾帧, 用错编号会串),
 *     用 <Subject N> 指代角色 (代码层权威编号, 不把中文角色名塞进英文 prompt)。
 */
import { logTaskProgress } from '../../utils/task-logger.js'

/** 一张角色形象图 (url + 角色名 + <Subject N> 编号) */
export interface CharacterRefItem {
  url: string
  name: string
  /** 该角色在本 episode 角色序列里的 1-based 下标 (= prompt 里 <Subject N> 的 N) */
  subjectIndex: number
}

/** 角色图最终占到的槽位 */
export interface CharacterRefSlot {
  slot: number
  subjectIndex: number
  name: string
}

/**
 * 把角色形象图并进参考图列表 (追加在末尾)。
 * @param refs      现有参考图 (首帧/尾帧在前, 顺序不动)
 * @param charRefs  本镜出场角色的形象图 (按 <Subject N> 升序)
 * @param maxImages 平台参考图上限 (9)
 */
export function mergeCharacterRefsIntoSlots(
  refs: string[],
  charRefs: CharacterRefItem[],
  maxImages: number,
): { refs: string[]; slots: CharacterRefSlot[]; dropped: string[] } {
  const slots: CharacterRefSlot[] = []
  const dropped: string[] = []
  const MAX = maxImages > 0 ? maxImages : Number.MAX_SAFE_INTEGER
  const next = [...(refs || [])]
  for (const c of charRefs || []) {
    if (!c?.url) continue
    if (next.length >= MAX) { dropped.push(c.name || c.url); continue }
    // 同一张图不重复发 (角色图可能和首帧是同一张)
    if (next.includes(c.url)) continue
    slots.push({ slot: next.length, subjectIndex: c.subjectIndex, name: c.name })
    next.push(c.url)
  }
  return { refs: next, slots, dropped }
}

/**
 * prompt 点名句 —— 说明每张角色立绘是谁, 并要求脸/发型/衣着与参考和帧保持一致。
 * ★ 编号 = 槽位 + 1 (H3 约定: Image N = ref_image_{N-1})。
 */
export function buildCharacterRefNotes(slots: CharacterRefSlot[]): string {
  if (!slots?.length) return ''
  const parts = slots.map(sl => `Image ${sl.slot + 1} is the appearance reference of <Subject ${sl.subjectIndex}>`)
  return `${parts.join('; ')}. Keep their faces, hairstyles and clothing identical to these references and to the frames; do not introduce any other person.`
}

/**
 * flow-log: 本次到底带了哪几个角色 / 各自槽位 / 对应 <Subject N> / 被丢弃的。
 */
export function logCharacterRefSlots(meta: {
  videoGenId?: number
  storyboardId?: number | null
  workflowId: string
  slots: CharacterRefSlot[]
  dropped?: string[]
  reason?: string
  hint?: string
}) {
  logTaskProgress('VideoTask', 'video-char-refs', {
    videoGenId: meta.videoGenId,
    storyboardId: meta.storyboardId,
    workflowId: meta.workflowId,
    count: meta.slots.length,
    slots: meta.slots.map(sl => ({
      slot: sl.slot,
      imageN: sl.slot + 1,
      subjectIndex: sl.subjectIndex,
      name: sl.name,
    })),
    dropped: meta.dropped || [],
    reason: meta.reason || null,
    hint: meta.hint || '角色形象图追加在首尾帧之后 (slot 2 起), 总数上限 9',
  })
}
