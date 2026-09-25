/**
 * TTS 试听预览服务 — 2026-09-25 PM msg-20260924-005 (Q4 voice_assigner preview TTS)
 *
 * 用途:
 *   voice_assigner agent 让 LLM 真听 base64 评估音色匹配度, 而不是凭直觉决策.
 *   agent 对每个候选 voice 生成 3-5 秒样本, 听 audio base64 后决策最佳 voice.
 *
 * 设计:
 *   1. 复用现有 TTS API (minimax speech-2.8-hd, 通过 generateTTS)
 *   2. 样本写 data/tts-preview/ 而不是 data/static/audio/ — 方便 24h lazy cleanup 不污染正式音频库
 *   3. 每次 preview 前先清理超过 24h 的旧样本 — lazy cleanup, 无需 cron
 *   4. 返回 { audioPath, base64, durationMs, voiceMeta } — base64 让 LLM 听, path 方便 QA 调试
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { generateTTS } from './tts-generation.js'
import { logTaskProgress, logTaskSuccess } from '../utils/task-logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_ROOT = process.env.DATA_PATH || path.resolve(__dirname, '../../../data')
const PREVIEW_DIR = path.join(DATA_ROOT, 'tts-preview')
const PREVIEW_MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24h

export interface TTSPreviewResult {
  audioPath: string            // 绝对路径, 方便 QA 调试
  relativePath: string         // 相对路径, 跟 static/audio 格式一致 (frontend 可访问)
  base64: string               // base64 mp3 — agent 听
  durationMs: number           // 音频时长
  fileSize: number             // 字节数
  voiceMeta: {
    voiceId: string
    emotion?: string
    speed?: number
  }
}

/**
 * Lazy cleanup: 清理 mtime 超过 24h 的 preview 样本
 * 每次 preview 调用前自动触发, 无需 cron
 */
export function cleanupOldPreviews(): { deletedCount: number; freedBytes: number } {
  fs.mkdirSync(PREVIEW_DIR, { recursive: true })
  const now = Date.now()
  let deletedCount = 0
  let freedBytes = 0

  try {
    const files = fs.readdirSync(PREVIEW_DIR)
    for (const file of files) {
      // 跳过 .gitkeep 等非 mp3 文件
      if (!file.endsWith('.mp3') && !file.endsWith('.hex')) continue
      const fp = path.join(PREVIEW_DIR, file)
      try {
        const stat = fs.statSync(fp)
        const age = now - stat.mtimeMs
        if (age > PREVIEW_MAX_AGE_MS) {
          freedBytes += stat.size
          fs.unlinkSync(fp)
          deletedCount++
        }
      } catch {
        // 单文件 stat 失败跳过
      }
    }
  } catch {
    // 目录读失败跳过
  }

  if (deletedCount > 0) {
    logTaskProgress('VoiceTool', 'preview-cleanup', { deletedCount, freedBytes })
  }
  return { deletedCount, freedBytes }
}

/**
 * 生成 TTS 试听样本
 *
 * @param text 5-15 字台词片段
 * @param voiceId 候选 voice id
 * @param speed 默认 1.0
 * @param emotion 默认 neutral
 * @param configId 可选 TTS config id
 */
export async function generateTTSPreview(
  text: string,
  voiceId: string,
  speed: number = 1.0,
  emotion: string = 'neutral',
  configId?: number | null,
): Promise<TTSPreviewResult> {
  // Step 1: lazy cleanup 旧样本 (24h+)
  cleanupOldPreviews()

  // Step 2: 调 TTS 生成样本 (复用 minimax speech-2.8-hd)
  // 注意: generateTTS 默认写到 data/static/audio/<uuid>.mp3
  const generatedPath = await generateTTS({ text, voice: voiceId, speed, emotion, configId })

  // Step 3: 移到 tts-preview/ 目录, 命名 <timestamp>-<voiceId>.mp3 方便识别
  const timestamp = Date.now()
  const safeVoiceId = voiceId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50)
  const previewFilename = `${timestamp}-${safeVoiceId}.mp3`

  // 找原文件绝对路径 — generatedPath 是相对路径 (static/audio/<uuid>.mp3)
  const STATIC_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../data/static')
  const srcAbsolute = path.join(STATIC_ROOT, 'audio', path.basename(generatedPath))

  const dstAbsolute = path.join(PREVIEW_DIR, previewFilename)
  fs.mkdirSync(PREVIEW_DIR, { recursive: true })

  let fileSize = 0
  try {
    const buf = fs.readFileSync(srcAbsolute)
    fs.writeFileSync(dstAbsolute, buf)
    fileSize = buf.length
    // 移完后删原文件 — 不污染 static/audio (preview 是临时文件, 不应该出现在正式音频库)
    fs.unlinkSync(srcAbsolute)
  } catch (err: any) {
    logTaskProgress('VoiceTool', 'preview-move-warn', {
      src: srcAbsolute,
      dst: dstAbsolute,
      error: err?.message,
    })
    // move 失败时回退用原路径
    return {
      audioPath: srcAbsolute,
      relativePath: generatedPath,
      base64: '',
      durationMs: 0,
      fileSize: 0,
      voiceMeta: { voiceId, emotion, speed },
    }
  }

  // Step 4: 读 mp3 转 base64 (返回给 LLM 评估)
  const mp3Buf = fs.readFileSync(dstAbsolute)
  const base64 = mp3Buf.toString('base64')

  // 估算 durationMs (粗估: 16kbps mp3 ≈ 2KB/s, 5秒样本 ≈ 10KB; 实际从文件名解析或调 ffprobe — 这里先返回 0 由 LLM 忽略)
  const durationMs = 0

  const result: TTSPreviewResult = {
    audioPath: dstAbsolute,
    relativePath: `tts-preview/${previewFilename}`, // 跟 static/audio 类似的相对路径格式
    base64,
    durationMs,
    fileSize,
    voiceMeta: { voiceId, emotion, speed },
  }

  logTaskSuccess('VoiceTool', 'preview-tts-complete', {
    voiceId,
    emotion,
    speed,
    audioPath: result.relativePath,
    fileSize,
    durationMs,
    textPreview: text.slice(0, 20),
  })

  return result
}
