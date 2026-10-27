/**
 * 宫格格子分配 —— 【唯一实现】(Sprint 27 Task A follow-up, PM msg-20261027-127)
 *
 * ★ 为什么要抽成共享文件:
 *   『每格属于哪个镜头 / 是首帧还是尾帧』这个算法在系统里原来有【两份实现】——
 *     ① backend/src/routes/grid.ts 的 buildGridCellPrompts / buildGridPrompt  (agent 失败时的 fallback 路径)
 *     ② backend/src/agents/tools/grid-prompt-tools.ts 的 first_last 分支        (正常路径, agent 调工具)
 *   Sprint 27 第一次只改了 ①, ② 还是老逻辑 → 同一个响应里:
 *     格子卡片内容 (来自 ②) 是【交替】的, 而 LLM 自己写的参考图映射是【成对】的
 *     → 用户看到的就是这份矛盾 (PM msg-20261027-127 的现象 A vs B)。
 *   → 现在所有产出点都从这里取, 不会再出现『改了一处漏了另一处』。
 *
 * first_last 的正确语义 (工单的 3 条硬约束):
 *   (a) 同一镜头的首帧和尾帧在【同一行相邻两格】, 首在左尾在右
 *   (b) 同一镜头的两格【不能被别的镜头拆开】
 *   (c) 镜头顺序按 storyboard_number 升序
 *   → 实现: 宫格固定 2 列, 第 i 格 = 镜头 floor(i/2), 偶数格=首帧、奇数格=尾帧。
 */

export type GridCellFrameType = 'first_frame' | 'last_frame' | 'reference'

export interface GridCellPlan {
  /** 格子在宫格里的下标 (0 起) */
  cellIndex: number
  /** 行 / 列 (0 起) */
  row: number
  col: number
  /** 该格对应传入 shots 数组里的第几个镜头 */
  shotIndex: number
  frameType: GridCellFrameType
}

export interface GridLayout {
  rows: number
  cols: number
  /** 选中的镜头数超过布局能放下的数量 (前端会 toast 提示, 不是静默截断) */
  truncated: boolean
}

/**
 * 归一宫格行列。
 *
 * first_last → 【固定 2 列】(每行 = 一个镜头的首帧 + 尾帧), 行数 clamp 到实际镜头数。
 *   为什么固定 2 列 (而不是保持用户选的 cols):
 *     · 奇数列下每行会空 1 格, 而【空格子在生图模型眼里不是空, 它会自己编内容填进去】→ 污染画面
 *     · 3行x2列 = 1920x1080 → 每格 960x540 (3x3 只有 640x360), 切出来当参考帧更清晰
 *     · 完全对齐 UI 文案『每镜头占一行: 左首帧 + 右尾帧』
 * 其它模式 (first_frame / multi_ref) 行为不变。
 */
export function normalizeGridLayout(mode: string, rows: number, cols: number, shotCount: number): GridLayout {
  const r = Math.max(1, Math.floor(Number(rows) || 1))
  const c = Math.max(1, Math.floor(Number(cols) || 1))
  if (mode === 'first_last') {
    const useRows = Math.min(r, Math.max(shotCount, 1))
    return { rows: useRows, cols: 2, truncated: useRows < r }
  }
  return { rows: r, cols: c, truncated: false }
}

/**
 * first_last 模式的格子分配方案 —— 同一镜头的首尾成对相邻。
 *
 * @param rows        宫格行数 (会被 clamp 到 shotCount)
 * @param shotCount   实际可用镜头数
 */
export function buildFirstLastCellPlan(rows: number, shotCount: number): GridCellPlan[] {
  const pairCols = 2
  const useRows = Math.min(Math.max(1, Math.floor(Number(rows) || 1)), Math.max(shotCount, 1))
  return Array.from({ length: useRows * pairCols }, (_, i) => ({
    cellIndex: i,
    row: Math.floor(i / pairCols),
    col: i % pairCols,
    shotIndex: Math.floor(i / pairCols),
    frameType: (i % pairCols === 0 ? 'first_frame' : 'last_frame') as GridCellFrameType,
  }))
}
