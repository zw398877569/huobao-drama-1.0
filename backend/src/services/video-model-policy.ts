/**
 * ★ Sprint 57 T1 (PM msg-20261123-225): 视频工作流「必须显式指定」判定 —— ★ 纯逻辑, 无任何 import
 *
 * 背景 (2026-11-23 事故): 批量视频点完没弹确认框 → 11 个镜一次性提交 → 请求里没有工作流
 *   → 后端 model 落到「配置清单里的第一个」= minimax_h3_lightx2v_no_pic (无图模式)
 *   → 全部计费, 但跑出来的效果不是用户要的, 这 11 个镜还得用正确工作流重跑一遍。
 *   根因 = 【缺工作流时静默回落】。
 *
 * ★ 规则:
 *   ① 请求里【明确给出】工作流 → 就用它 (一字不变)
 *   ② 没给 + 该配置的工作流清单【只有一个】→ 用它 (不存在"默认选择"的歧义;
 *      单工作流配置如 Hailuo / Agnes 不该被这条规则卡死)
 *   ③ 没给 + 清单有多个 / 拿不到清单 → 【拒绝】, 一条请求都不许发到平台
 *      (尤其是 no_pic 无图模式: 只能由用户显式选, 任何隐式回落都不行)
 *
 * ★ 本文件刻意不 import 任何东西 → QA / DEV 都能直接 import 跑离线断言。
 */

/** 缺工作流时的错误 (message 直接给用户看) */
export class VideoModelRequiredError extends Error {
  // ★ 不用 TS 构造函数参数属性 (public x) —— node 的 strip-only 模式不支持,
  //   写成普通字段才能让 QA / DEV 直接 `import` 这个 .ts 文件跑离线断言
  configId: number | null
  models: string[]
  constructor(configId: number | null, models: string[], message?: string) {
    super(message || (
      models.length
        ? `必须指定视频工作流: 当前视频配置 (id=${configId}) 有多个工作流 (${models.join(', ')}), 系统不会替你默认选 —— 请先在剧集页顶部选择视频模型/工作流`
        : `必须指定视频工作流: 请求里没有带 model, 且当前视频配置 (id=${configId}) 的工作流清单无法解析 —— 请先在剧集页顶部选择视频模型/工作流`
    ))
    this.name = 'VideoModelRequiredError'
    this.configId = configId
    this.models = models
  }
}

export type VideoModelDecision =
  | { ok: true; model: string }
  | { ok: false; error: string }

/**
 * 判定视频工作流 —— ★ 纯函数 (入参 → 出参, 无副作用, 可离线断言)
 * @param explicitModel 请求里【明确给出】的工作流 (前端选了就会带)
 * @param models        该配置的工作流清单
 */
export function decideVideoModel(
  explicitModel: string | null | undefined,
  models: string[],
): VideoModelDecision {
  const m = (explicitModel || '').trim()
  if (m) return { ok: true, model: m }
  if (models.length === 1) return { ok: true, model: models[0] }
  return {
    ok: false,
    error: models.length
      ? `必须指定视频工作流: 当前视频配置有多个工作流 (${models.join(', ')}), 系统不会替你默认选 —— 请先在剧集页顶部选择视频模型/工作流`
      : '必须指定视频工作流: 请求里没有带 model, 且当前视频配置的工作流清单无法解析 —— 请先在剧集页顶部选择视频模型/工作流',
  }
}
