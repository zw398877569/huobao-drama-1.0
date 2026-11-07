/**
 * 角色档案里的【剧情道具】剥离 — Sprint 36 (PM msg-20261106-155)
 *
 * 【问题】LLM 抽角色时把剧情道具写进了 permanent_outfit (drama 19 案例: 林达 outfit 段里
 *   混进「深蓝色外卖保温箱」) → 角色形象图 (三视图, 含背面) 照着画出来 →
 *   这张角色形象图进了【每一镜】的参考图 → 画面凭空多一个道具 (镜#8 交接完手上还背着一个)。
 *
 * 【方案】生成【角色形象图】/ 拼【镜头 prompt】时, 把与本剧道具表匹配的条目剔掉。
 *   - 只动【角色侧文本】: characters.appearance_permanent 派生出的那段文字。
 *     逐镜 image_prompt / image_prompt_permanent / image_prompt_plot_state / props 表 一律不动。
 *   - 真正的【服装与随身物】必须留下 (黑色连帽外卖雨衣 / 灰色工装长裤 / 黑色防滑雨靴 /
 *     胸前外卖工牌挂绳) —— 角色一致性靠这张图, 削过头会掉人设。
 *     → 所以带【服装/佩戴类关键词】的条目一律保护, 不管它是否命中道具表。
 *
 * 【为什么不改写入路径】写入路径 (LLM 抽角色) 只能防【未来】的数据; 已经生成的旧剧集
 *   (角色档案早就写好了) 不会自动变干净 —— PM 的验收就是「重新生成角色形象图 → 图里没有箱子」,
 *   所以必须在【读取路径】过滤。
 *
 * ⚠️ 前端有一份同语义实现: frontend/app/utils/prop-guard.ts
 *   (前端拼镜头 prompt 时也要过滤角色档案文本 —— 那边不改的话, 镜头 prompt 里
 *    「林达外貌: ... 深蓝色外卖保温箱 ...」仍在要求模型给主角挂箱子)。
 *   两边改动必须同步, 语义保持一致。
 */

export interface PropLike {
  name?: string | null
}

/** 服装 / 随身佩戴类关键词 —— 命中的条目【永远不删】, 哪怕它跟道具表重名。
 *  (工牌挂绳 / 眼镜 / 手表 / 背包 这些是角色常驻, 道具表里可能也有, 但不能误删) */
const CLOTHING_GUARD = /(衣|裤|靴|鞋|帽|衫|裙|服|甲|巾|帕|围|链|环|耳|脖|徽|章|绳|带|扣|夹|针|镜|表|包|兜|袖|领|袜|囊|袋|扇)/

/** permanent_traits 里表示「服装」的 category 前缀 —— 只有这些类别的值才会逐条拆 '，' 过滤 */
const OUTFIT_CATEGORY = /^(outfit|attire|clothing|costume|服装|衣着|穿着)$/i

/** 去掉空白 + 标点, 小写 —— 只用于比较, 不用于展示 */
function normalize(s: string): string {
  return (s || '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[，。、·|｜:：;；!！?？"'“”‘’()（）\[\]【】<>《》/\\\-_~`*]/g, '')
    .toLowerCase()
}

/**
 * 道具名 → 匹配用的 key 集合。
 * 除了全名, 再加一个「尾部核心词」(末 3 字): 档案里常写简称 (道具叫「深蓝色外卖保温箱」,
 * 档案写「保温箱」) —— 只取末 3 字, 不取更短, 避免「箱」这种单字乱命中。
 */
function buildPropKeys(props: PropLike[]): string[] {
  const keys = new Set<string>()
  for (const p of props || []) {
    const n = normalize(p?.name || '')
    if (!n) continue
    keys.add(n)
    if (n.length >= 4) keys.add(n.slice(-3))
  }
  return [...keys]
}

/** 这一条文本是否该被当成【剧情道具】剔掉 */
function isPropItem(item: string, keys: string[]): boolean {
  const it = normalize(item)
  if (!it) return false
  if (CLOTHING_GUARD.test(it)) return false      // 服装/随身物 → 保护
  return keys.some(k => k && (it.includes(k) || (it.length >= 2 && k.includes(it))))
}

/** "outfit: 黑色连帽雨衣，深蓝色外卖保温箱" → 拆成 2 段逐条判 */
function splitOutfitValue(value: string): string[] {
  return value.split(/[，,、]/)
}

/**
 * 从角色档案文本里剔掉剧情道具条目。
 * @param text characters.appearance_permanent 原文
 * @param props 本剧道具 (props 表, 一般按 drama_id 查全量)
 * @returns { text: 过滤后的文本, removed: 被剔掉的条目 (用于日志留痕) }
 */
export function stripPropsFromAppearance(text: string, props: PropLike[]): { text: string; removed: string[] } {
  if (!text || !props?.length) return { text: text || '', removed: [] }
  const keys = buildPropKeys(props)
  if (!keys.length) return { text, removed: [] }
  const removed: string[] = []

  const outSections = text.split(' / ').map(section => {
    // ★ 用 map 而不是 filter: outfit 维度那类项需要【改写】(把里面的道具剔掉再拼回去),
    //   filter 只能决定留不留, 改不了内容 (踩过一次: 剔了但文本里还在)。
    const outItems = section.split(' | ').map(item => {
      const raw = item.trim()
      if (!raw) return item
      // 带 category 前缀的项 = permanent_traits (gender/age/face/hair/body/outfit)
      const m = /^([^:：]{1,12})[:：]\s*(.+)$/.exec(raw)
      if (m) {
        if (!OUTFIT_CATEGORY.test(m[1].trim())) return item   // 非服装类 trait → 不动
        const parts = splitOutfitValue(m[2])
        const kept = parts.filter(p => {
          if (isPropItem(p, keys)) { removed.push(p.trim()); return false }
          return true
        })
        return `${m[1].trim()}: ${kept.join('，')}`
      }
      // 没有 category 前缀 = permanent_outfit 列表里的条目 (服装/装饰) → 逐条判
      if (isPropItem(raw, keys)) { removed.push(raw); return null }
      return item
    }).filter((i): i is string => i !== null)
    return outItems.join(' | ')
  })

  return { text: outSections.join(' / '), removed }
}
