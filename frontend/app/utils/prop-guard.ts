/**
 * 角色档案里的【剧情道具】剥离 — Sprint 36 (PM msg-20261106-155) 【前端同语义实现】
 *
 * ⚠️ 与 backend/src/utils/prop-guard.ts 必须保持一致 (两边改动要同步)。
 *
 * 【为什么前端也要一份】拼镜头图 prompt 时, 前端会把角色的 appearance_permanent 整段塞进去:
 *   「林达外貌:gender: 男 | ... | 深蓝色外卖保温箱 | ...」+ 参考图 legend 里也有一份。
 *   后端把角色形象图画干净了, 但这两处文字仍在要求模型「给主角挂个保温箱」→
 *   画面照样多一个箱子 (AC: 镜#7 手里提【一个】, 镜#8 身上【没有】第二个)。
 *
 * 【只动角色侧文本】逐镜 image_prompt / image_prompt_permanent / image_prompt_plot_state 一律不动。
 */

export interface PropLike {
  name?: string | null
}

/** 服装 / 随身佩戴类关键词 —— 命中的条目【永远不删】, 哪怕它跟道具表重名 */
const CLOTHING_GUARD = /(衣|裤|靴|鞋|帽|衫|裙|服|甲|巾|帕|围|链|环|耳|脖|徽|章|绳|带|扣|夹|针|镜|表|包|兜|袖|领|袜|囊|袋|扇)/

/** permanent_traits 里表示「服装」的 category 前缀 */
const OUTFIT_CATEGORY = /^(outfit|attire|clothing|costume|服装|衣着|穿着)$/i

function normalize(s: string): string {
  return (s || '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[，。、·|｜:：;；!！?？"'“”‘’()（）\[\]【】<>《》/\\\-_~`*]/g, '')
    .toLowerCase()
}

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

function isPropItem(item: string, keys: string[]): boolean {
  const it = normalize(item)
  if (!it) return false
  if (CLOTHING_GUARD.test(it)) return false
  return keys.some(k => k && (it.includes(k) || (it.length >= 2 && k.includes(it))))
}

function splitOutfitValue(value: string): string[] {
  return value.split(/[，,、]/)
}

/**
 * 从角色档案文本里剔掉剧情道具条目。
 * @param text characters.appearance_permanent 原文
 * @param props 本集道具 (ctx.keyProps)
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
      const m = /^([^:：]{1,12})[:：]\s*(.+)$/.exec(raw)
      if (m) {
        if (!OUTFIT_CATEGORY.test(m[1].trim())) return item
        const parts = splitOutfitValue(m[2])
        const kept = parts.filter(p => {
          if (isPropItem(p, keys)) { removed.push(p.trim()); return false }
          return true
        })
        return `${m[1].trim()}: ${kept.join('，')}`
      }
      if (isPropItem(raw, keys)) { removed.push(raw); return null }
      return item
    }).filter((i): i is string => i !== null)
    return outItems.join(' | ')
  })

  return { text: outSections.join(' / '), removed }
}
