/**
 * ★ Sprint 58 追加 (PM msg-20261124-230): 分辨率档位的【显示文案】备注
 *
 * 背景: minimax_h3_803 的 768p 档【只有竖屏有】(平台枚举里 803 只有 '1088p竖/1088p横/1440p竖/1440p横'
 *   + 一个仅竖屏的 768p 档) → 横屏镜选了 768p, 平台会静默回落到默认档 1088p (更贵),
 *   而下拉里两个档位长得一模一样 → 用户选了等于白选。
 *
 * ★ 本单【只加显示文案】: 行为 / 回落逻辑 / 落库值 一个字都不改 (PM 拍板)。
 *   ★ 显示文案【不进到提交值里】—— option 的 :value 仍然是纯档位 ('768p'),
 *     提交给后端的 / 落库的 video_generations.resolution 也仍然是 '768p'。
 */

/** 工作流 → 档位 → 显示备注 (只覆盖需要提示的档位) */
export const TIER_DISPLAY_NOTES: Record<string, Record<string, string>> = {
  // ★ 803 的 768p 只有竖屏 → 横屏镜选了会静默按默认档生成
  minimax_h3_803: { '768p': '768p(只支持竖屏)' },
}

/**
 * 档位的显示文案 —— ★ 纯函数 (入参 → 出参, 无副作用, 可离线断言)
 * @param tier     档位 ('768p' / '1088p' / '1440p' ...)
 * @param workflow 当前工作流 id (只有 minimax_h3_803 有备注; 其它工作流一字不变)
 */
export function resolutionTierLabel(tier: string, workflow?: string | null): string {
  const note = workflow ? TIER_DISPLAY_NOTES[workflow]?.[tier] : undefined
  return note || tier
}
