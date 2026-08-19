/**
 * Nano Banana 图像生成 Adapter
 * 文档: /Users/mac/Obsidian/ComfyUi/nanoBanana.md
 * 国内直连: https://grsai.dakka.com.cn
 * 海外节点: https://grsaiapi.com
 * 端点: POST {base_url}/draw/nano-banana
 * 轮询: POST {base_url}/draw/result
 *
 * 设计要点:
- 鉴权: Authorization: Bearer <apiKey>
- 异步任务: 必须传 webHook="-1" 强制轮询模式(避免 webhook 回调链路)
- 输出: URL(2小时有效),不支持 base64
- aspectRatio: 从 record.size 推断(nano-banana 不用像素,用比例字符串)
- imageSize: 默认 "1K",由 model 决定支持上限(2K/4K 需选 nano-banana-2-2k-cl 等专用 model)
 */
import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types'
import { joinProviderUrl } from './url'

export class NanoBananaImageAdapter implements ImageProviderAdapter {
  readonly provider = 'nano-banana'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const baseUrl = config.baseUrl || 'https://grsai.dakka.com.cn/v1'

    const body: any = {
      model: record.model || 'nano-banana-fast',
      prompt: record.prompt || '',
      // 强制轮询模式: webHook="-1" 让端点立即返回 task_id
      webHook: '-1',
      shutProgress: false,
    }

    // aspectRatio: 像素 size → 比例字符串
    const aspectRatio = this.sizeToAspectRatio(record.size)
    if (aspectRatio) body.aspectRatio = aspectRatio

    // imageSize: 默认 1K(huobao schema 暂无此字段,留 TODO 由 model 选择决定)
    body.imageSize = '1K'

    // 参考图(支持 URL 数组)
    if (record.referenceImages) {
      try {
        const refs = JSON.parse(record.referenceImages)
        if (Array.isArray(refs) && refs.length > 0) {
          body.urls = refs.filter((u): u is string => typeof u === 'string' && u.length > 0)
        }
      } catch {
        // ignore parse errors
      }
    }

    return {
      url: joinProviderUrl(baseUrl, '', '/draw/nano-banana'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    // 异步响应: { code: 0, msg: "success", data: { id: "..." } }
    const taskId = result?.data?.id || result?.id
    if (taskId) {
      return { isAsync: true, taskId }
    }
    // 兼容同步返回(部分 webhook 回调路径可能直接给 url)
    const imageUrl = this.extractImageUrl(result)
    if (imageUrl) {
      return { isAsync: false, imageUrl }
    }
    throw new Error(
      `Nano Banana: no task_id or url in response: ${JSON.stringify(result).slice(0, 200)}`
    )
  }

  buildPollRequest(config: AIConfig, _videoId: string, taskId?: string): ProviderRequest {
    if (!taskId) {
      throw new Error('Nano Banana: taskId required for polling')
    }
    const baseUrl = config.baseUrl || 'https://grsai.dakka.com.cn/v1'
    return {
      url: joinProviderUrl(baseUrl, '', '/draw/result'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: { id: taskId },
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    // 响应: { code: 0, msg: "success", data: { id, results: [{url, content}], progress, status, failure_reason, error } }
    const data = result?.data || result || {}
    const status = String(data?.status || '').toLowerCase()

    if (status === 'succeeded') {
      const imageUrl = this.extractImageUrl(result)
      return { status: 'completed', imageUrl: imageUrl || undefined }
    }

    if (status === 'failed') {
      const reason = data?.failure_reason || 'unknown'
      const detail = data?.error || 'Nano Banana generation failed'
      return { status: 'failed', error: `${reason}: ${detail}` }
    }

    // running / 任何中间状态都视为 processing
    return { status: 'processing' }
  }

  extractImageUrl(result: any): string | null {
    const data = result?.data || result || {}
    const results = data?.results
    if (Array.isArray(results) && results.length > 0) {
      return results[0]?.url || null
    }
    return null
  }

  extractImageBase64(_result: any): { data: string; mimeType: string } | null {
    // Nano Banana 只返回 URL,不支持 base64 直接输出
    return null
  }

  /**
   * 将像素 size("1024x768") 推断为 nano-banana aspectRatio 字符串
   * nano-banana 支持: auto, 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 5:4, 4:5, 21:9
   * nano-banana-2 系列额外支持: 1:4, 4:1, 1:8, 8:1
   * 默认 fallback 到 'auto' 让 nano-banana 自己决定
   */
  private sizeToAspectRatio(size?: string | null): string | null {
    if (!size) return null
    const [w, h] = size.split('x').map(Number)
    if (!w || !h) return null
    const ratio = w / h

    const presets: Array<[string, number]> = [
      ['1:1', 1],
      ['16:9', 16 / 9],
      ['9:16', 9 / 16],
      ['4:3', 4 / 3],
      ['3:4', 3 / 4],
      ['3:2', 3 / 2],
      ['2:3', 2 / 3],
      ['5:4', 5 / 4],
      ['4:5', 4 / 5],
      ['21:9', 21 / 9],
    ]

    // tolerance 0.05 足以覆盖常见舍入
    for (const [name, value] of presets) {
      if (Math.abs(ratio - value) < 0.05) return name
    }
    return 'auto'
  }
}
