/**
 * Nano Banana 图像生成 Adapter (v2 API, 2026-08-19)
 * 文档: /Users/mac/Obsidian/ComfyUi/nanoBanana（new）.md
 * 国内直连: https://grsai.dakka.com.cn
 * 海外节点: https://grsaiapi.com
 * 端点: POST {base_url}/api/generate
 * 轮询: GET  {base_url}/api/result?id={task_id}
 *
 * v2 相对 v1 的变化:
 * - 端点 /v1/draw/nano-banana → /v1/api/generate
 * - 端点 /v1/draw/result    → /v1/api/result (GET 而不是 POST)
 * - 字段 urls → images(参考图,仍支持 URL 与 base64)
 * - 新增 replyType 字段: json(同步) / stream(流式) / async(异步轮询)
 * - 异步模式提交响应简化:{ id, status: "running" }(不再有 code/msg/data 包装)
 * - 轮询响应同样简化(顶层就是对象,不再嵌套 data)
 * - 新增 status 值:"violation"(违规) — 与 "failed" 同等处理
 *
 * 设计要点:
 * - 鉴权: Authorization: Bearer <apiKey>
 * - 强制 replyType="async" 走轮询(adapter 不支持 stream consumer)
 * - 输出: URL(2 小时有效),不支持 base64
 * - aspectRatio: 从 record.size 推断
 * - imageSize: 默认 "1K",由 model 决定支持上限
 *
 * ⚠️ buildPollRequest 签名陷阱:ImageProviderAdapter interface 声明
 * `buildPollRequest(config, videoId, taskId?)`,但 image-generation.ts
 * 实际只传 2 个参数 `(config, taskId)`,把 taskId 当作 videoId 位置传入。
 * 跟随其他 image adapter (ali / volcengine) 写法,只用 2 个参数,
 * 第二个参数就是 taskId。
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
      // 强制异步轮询模式 — adapter 不支持 stream consumer
      replyType: 'async',
    }

    // aspectRatio: 像素 size → 比例字符串
    const aspectRatio = this.sizeToAspectRatio(record.size)
    if (aspectRatio) body.aspectRatio = aspectRatio

    // imageSize: 默认 1K(由 model 决定支持上限)
    body.imageSize = '1K'

    // 参考图(支持 URL 与 base64)
    if (record.referenceImages) {
      try {
        const refs = JSON.parse(record.referenceImages)
        if (Array.isArray(refs) && refs.length > 0) {
          body.images = refs.filter((u): u is string => typeof u === 'string' && u.length > 0)
        }
      } catch {
        // ignore parse errors
      }
    }

    return {
      url: joinProviderUrl(baseUrl, '', '/api/generate'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    // v2 异步响应(顶层):
    //   { id: "...", status: "running" }
    // 或成功时:
    //   { id: "...", status: "succeeded", results: [{ url: "..." }] }
    const taskId = result?.id
    if (taskId && String(result?.status || '').toLowerCase() === 'running') {
      return { isAsync: true, taskId }
    }
    // 兼容同步返回(选了 json 模式或服务端已经生成完成)
    const imageUrl = this.extractImageUrl(result)
    if (imageUrl) {
      return { isAsync: false, imageUrl }
    }
    throw new Error(
      `Nano Banana: no task_id or url in response: ${JSON.stringify(result).slice(0, 200)}`
    )
  }

  // ⚠️ 见顶部 doc — 2 参数 (config, taskId),不是 interface 写的 3 参数
  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    if (!taskId) {
      throw new Error('Nano Banana: taskId required for polling')
    }
    const baseUrl = config.baseUrl || 'https://grsai.dakka.com.cn/v1'
    return {
      // GET 方法, taskId 作为 query string (非 body)
      url: `${joinProviderUrl(baseUrl, '', '/api/result')}?id=${encodeURIComponent(taskId)}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    // v2 轮询响应(顶层,无 data 包装):
    //   { id, status: "running" | "succeeded" | "violation" | "failed", progress?, results?, error? }
    const status = String(result?.status || '').toLowerCase()

    if (status === 'succeeded') {
      const imageUrl = this.extractImageUrl(result)
      return { status: 'completed', imageUrl: imageUrl || undefined }
    }

    if (status === 'failed' || status === 'violation') {
      const detail = result?.error || `Nano Banana generation ${status}`
      return { status: 'failed', error: detail }
    }

    // running / 任何中间状态都视为 processing
    return { status: 'processing' }
  }

  extractImageUrl(result: any): string | null {
    const results = result?.results
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
