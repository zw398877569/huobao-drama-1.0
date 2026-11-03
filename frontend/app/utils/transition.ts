/**
 * ★ Sprint 33 T5 (PM msg-20261103-140): 过渡镜的前端工具。
 *
 * 背景: 过渡镜 = 一个镜头内完成状态切换的桥镜 (跨 scene 空间切换 / 同 scene 人物入场)。
 *   它的【尾帧】直接复用【后一镜的首帧】(同一张图) → 过渡镜→后一镜 那一刀 100% 连续。
 *   代价: 后一镜的首帧【不能再参考过渡镜尾帧】(会成环) → 接力链找上一镜时要跳过过渡镜。
 *
 * 数据来源: storyboards.is_transition / storyboards.transition_kind (T3 已落库)。
 */

/** 该镜是不是过渡镜 */
export function isTransitionShot(s: any): boolean {
  return s?.is_transition === true || s?.isTransition === true
}

/** 过渡镜类型: space (跨 scene 空间切换) / character_entry (同 scene 人物入场); 非过渡镜 → null */
export function transitionKindOf(s: any): 'space' | 'character_entry' | null {
  const k = s?.transition_kind ?? s?.transitionKind
  return k === 'space' || k === 'character_entry' ? k : null
}

/**
 * 是不是【character_entry 类】过渡镜 —— 这类的首帧里【没有人】(人物尚未入画)。
 *   → 首帧【不传角色形象图】(传了模型一上来就把人画完整, 『尚未入画』就实现不了)
 *   → 首帧的【人物外貌】由后端 assemble 阶段从 permanent 里剔除
 */
export function isCharacterEntryTransition(s: any): boolean {
  return isTransitionShot(s) && transitionKindOf(s) === 'character_entry'
}
