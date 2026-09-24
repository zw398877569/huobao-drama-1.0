/**
 * Migration runner: 2026-09-24 split characters.appearance → appearance_permanent + appearance_plot_state
 *
 * Phase 2 (after manual-2026-09-24-split-character-appearance.sql Phase 1):
 *   复杂行 (含 plot 阶段关键词) — 按关键词位置切段, 关键词 → intent_function 映射:
 *     早期 → 铺垫
 *     中期 → (skip, 罕用)
 *     后期 → 高潮
 *     高潮 → 高潮
 *     衰亡 → 余韵
 *
 * Forward only. 幂等 (WHERE appearance_permanent IS NULL 守卫).
 *
 * 手动执行:
 *   cd backend && npx tsx migrations/run-2026-09-24-split-character-appearance.ts
 */

import Database from 'better-sqlite3'
import path from 'path'

const DB_PATH = process.env.DB_PATH || path.resolve(process.cwd(), '../data/huobao_drama.db')

const sqlite = new Database(DB_PATH, { timeout: 30000 })
sqlite.pragma('busy_timeout = 30000')

interface Row {
  id: number
  appearance: string
}

interface PlotState {
  [intentFunction: string]: string
}

const KEYWORD_TO_INTENT: Record<string, string | null> = {
  早期: '铺垫',
  中期: null, // skip
  后期: '高潮',
  高潮: '高潮',
  衰亡: '余韵',
}

// 按出现位置升序排序的关键词, 用于从左到右扫描
const KEYWORDS = Object.keys(KEYWORD_TO_INTENT)

/**
 * 提取每段内容:
 * - 找到第一个关键词位置 first_pos
 * - permanent = text before first_pos (trim 末尾标点)
 * - 对每个关键词 p:
 *   - p_pos = 关键词起始位置
 *   - next_pos = 下一个出现的关键词位置 (或 length+1 表示末尾)
 *   - section = text 从 p_pos + len(p) 到 next_pos
 *   - 映射到 intent_function key
 */
function splitAppearance(appearance: string): { permanent: string; plotState: PlotState } {
  // 计算所有关键词位置
  const positions: Array<{ pos: number; keyword: string }> = []
  for (const kw of KEYWORDS) {
    let searchFrom = 0
    while (true) {
      const idx = appearance.indexOf(kw, searchFrom)
      if (idx < 0) break
      positions.push({ pos: idx, keyword: kw })
      searchFrom = idx + 1
    }
  }
  positions.sort((a, b) => a.pos - b.pos)

  if (positions.length === 0) {
    // 没关键词 (防御, Phase 1 已处理)
    return { permanent: appearance.trim(), plotState: {} }
  }

  // permanent = 第一个关键词之前的文本
  const firstPos = positions[0]!.pos
  const permanent = appearance.substring(0, firstPos).trim().replace(/[,;。 ]+$/, '').trim()

  // 遍历每个关键词位置, 提取 section
  const plotState: PlotState = {}
  for (let i = 0; i < positions.length; i++) {
    const cur = positions[i]!
    const intentKey = KEYWORD_TO_INTENT[cur.keyword]
    if (!intentKey) continue // 中期 skip

    // section 范围: [cur.pos + cur.keyword.length, positions[i+1]?.pos ?? length]
    const sectionStart = cur.pos + cur.keyword.length
    const sectionEnd = i + 1 < positions.length ? positions[i + 1]!.pos : appearance.length
    const section = appearance.substring(sectionStart, sectionEnd).trim().replace(/^[:,,;。 ]+/, '').replace(/[,;。 ]+$/, '').trim()

    if (section.length > 0) {
      plotState[intentKey] = section
    }
  }

  return { permanent, plotState }
}

// 找出待迁移的 rows (Phase 2: 含 plot 关键词的行, 但 appearance_permanent 仍为 NULL)
const rows = sqlite
  .prepare(
    `SELECT id, appearance FROM characters
     WHERE appearance_permanent IS NULL
       AND appearance IS NOT NULL
       AND appearance != ''
       AND (
         appearance LIKE '%早期%' OR appearance LIKE '%中期%'
         OR appearance LIKE '%后期%' OR appearance LIKE '%高潮%' OR appearance LIKE '%衰%'
       )`,
  )
  .all() as Row[]

console.log(`[migration] Phase 2 — found ${rows.length} rows with plot keywords to split`)

const updateStmt = sqlite.prepare(
  `UPDATE characters SET appearance_permanent = ?, appearance_plot_state = ? WHERE id = ?`,
)

let updated = 0
let noSection = 0

const tx = sqlite.transaction((batch: Row[]) => {
  for (const row of batch) {
    const { permanent, plotState } = splitAppearance(row.appearance)
    const plotStateJson = Object.keys(plotState).length > 0 ? JSON.stringify(plotState) : null

    if (permanent.length === 0 && !plotStateJson) {
      // 没有任何有效内容 (全部是关键词噪音), 跳过
      noSection++
      continue
    }

    updateStmt.run(permanent || null, plotStateJson, row.id)
    updated++
  }
})

tx(rows)

console.log(`[migration] Phase 2 done — updated ${updated} rows, ${noSection} skipped (no valid content)`)

// 验证
const remaining = sqlite
  .prepare(
    `SELECT COUNT(*) as cnt FROM characters
     WHERE appearance_permanent IS NULL
       AND appearance IS NOT NULL
       AND appearance != ''`,
  )
  .get() as { cnt: number }

console.log(`[migration] remaining rows with appearance_permanent=NULL: ${remaining.cnt}`)
console.log(remaining.cnt === 0 ? '[migration] ✅ all rows migrated' : '[migration] ⚠️  some rows still unmigrated')

sqlite.close()
