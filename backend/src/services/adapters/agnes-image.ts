/**
 * Agnes AI 图片生成 Adapter
 * 端点: POST /v1/images/generations
 * 同步返回，响应: { data: [{ url: "...", b64_json: "..." }] }
 * 图生图/多图: extra_body.image 数组
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

export class AgnesImageAdapter implements ImageProviderAdapter {
  provider = 'agnes'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const size = record.size || '1024x768'

    const body: any = {
      model: record.model || 'agnes-image-2.0-flash',
      prompt: record.prompt,
      size,
      n: 1,
      extra_body: {
        response_format: 'url',
      },
    }

    // 图生图 / 多图合成
    if (record.referenceImages) {
      try {
        const refs = JSON.parse(record.referenceImages)
        if (refs.length > 0) {
          body.extra_body.image = refs
        }
      } catch {
        // 不是 JSON 数组，忽略
      }
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/images/generations'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    // Agnes 图片生成是同步返回
    const imageUrl = result.data?.[0]?.url
    if (imageUrl) {
      return { isAsync: false, imageUrl }
    }
    const b64 = result.data?.[0]?.b64_json
    if (b64) {
      return { isAsync: false, imageUrl: undefined }
    }
    throw new Error('No image URL or b64_json in response')
  }

  buildPollRequest(_config: AIConfig, _taskId: string): ProviderRequest {
    return {
      url: '',
      method: 'GET',
      headers: {},
      body: undefined,
    }
  }

  parsePollResponse(_result: any): ImagePollResponse {
    return { status: 'pending' }
  }

  extractImageUrl(result: any): string | null {
    return result.data?.[0]?.url || null
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    const b64 = result.data?.[0]?.b64_json
    if (b64) {
      return { data: b64, mimeType: 'image/png' }
    }
    return null
  }
}
