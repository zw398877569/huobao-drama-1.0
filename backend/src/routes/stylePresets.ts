/**
 * 风格/反向提示词预设 endpoint
 *
 * 用途: 替代前端 4 处硬编码 (styleOptions / STYLE_LABELS / NEGATIVE_PROMPT_PRESETS)
 * 数据从 services/negative-prompt-presets.ts 直接出, 不进 DB (静态配置, 改起来不频繁)
 *
 * 数据小, 无需分页, 客户端 useStylePresets composable 模块级 cache + inflight 防重复
 */
import { Hono } from 'hono'
import { success } from '../utils/response.js'
import { STYLE_PRESETS, NEGATIVE_PROMPT_PRESETS } from '../services/negative-prompt-presets.js'

const app = new Hono()

app.get('/', (c) => {
  return success(c, {
    stylePresets: STYLE_PRESETS,
    negativePresets: NEGATIVE_PROMPT_PRESETS,
  })
})

export default app
