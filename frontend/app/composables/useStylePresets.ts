/**
 * 风格/反向提示词预设 composable
 *
 * 单一来源: 后端 /api/v1/style-presets
 * 取代之前散落在 4 处的硬编码 (styleOptions / STYLE_LABELS / NEGATIVE_PROMPT_PRESETS)
 *
 * 模块级 cache + inflight:
 *   - 第一次调用触发 fetch, 后续直接用 cache
 *   - 同时多次调用共用一个 in-flight Promise, 不会重复请求
 *   - 切换路由不重置 (SPA), 数据一次拉取多次使用
 */
import { stylePresetAPI } from '~/composables/useApi'

export interface StylePreset {
  slug: string
  label: string
  hint?: string
  positiveCharacterTokens: string
  positiveShotTokens: string
  keywords: string[]
}

export interface NegativePreset {
  id: string
  label: string
  keywords: string[]
  prompt: string
}

let cached: { stylePresets: StylePreset[]; negativePresets: NegativePreset[] } | null = null
let inflight: Promise<{ stylePresets: StylePreset[]; negativePresets: NegativePreset[] }> | null = null

export function useStylePresets() {
  const stylePresets = ref<StylePreset[]>(cached?.stylePresets || [])
  const negativePresets = ref<NegativePreset[]>(cached?.negativePresets || [])
  const loaded = ref(!!cached)
  const error = ref<Error | null>(null)

  async function load() {
    if (cached) return cached
    if (inflight) return inflight
    inflight = stylePresetAPI.list()
      .then((data: any) => {
        cached = data
        stylePresets.value = data.stylePresets
        negativePresets.value = data.negativePresets
        loaded.value = true
        return data
      })
      .catch((e: any) => {
        error.value = e
        throw e
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }

  // UI helper: slug → 中文 label (替换之前的 STYLE_LABELS map)
  function styleLabel(slug?: string | null): string {
    if (!slug) return ''
    return stylePresets.value.find(s => s.slug === slug)?.label || slug
  }

  // UI helper: slug → hint (dropdown 副标题)
  function styleHint(slug?: string | null): string {
    if (!slug) return ''
    return stylePresets.value.find(s => s.slug === slug)?.hint || ''
  }

  return {
    stylePresets,
    negativePresets,
    loaded,
    error,
    load,
    styleLabel,
    styleHint,
  }
}
