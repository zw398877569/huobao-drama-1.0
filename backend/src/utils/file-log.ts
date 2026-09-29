import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 默认 /app/data/flow-logs — docker-compose 把 /app/data 挂到 host 的 D:/aicg1.0/data,
// 这样 logs/ 在 Windows host 上能直接看到 (跟 llm-debug 同位置同风格).
// dev 模式 (tsx watch 本地跑) 设 FLOW_LOG_DIR=./logs 覆盖到 backend/logs/
const LOG_DIR = process.env.FLOW_LOG_DIR || '/app/data/flow-logs'

// 单文件最大 50MB — 超限自动切分到 flow-${traceId}-${seq}.jsonl
const MAX_FILE_BYTES = 50 * 1024 * 1024

/**
 * 开关：默认开启（PM 要求先跑两周看体积）。
 * 关闭方式：环境变量 FLOW_LOG_ENABLED=false（或 0）
 * 等全链路稳定后设 false，不再本地落盘。
 */
export function isFlowLogEnabled(): boolean {
  const v = (process.env.FLOW_LOG_ENABLED ?? 'true').toLowerCase()
  return v !== 'false' && v !== '0' && v !== 'no' && v !== 'off'
}

/**
 * 本地日期子目录 — 用户 2026-09-29 拍板用本地时间 (Asia/Shanghai) 按天分目录方便按日期查找。
 * 用本地 getFullYear/getMonth/getDate 而非 toISOString (UTC), 用户看到的日历 = 文件夹名。
 * 月日不足 2 位补 0 → 目录名全 ASCII 'YYYY-MM-DD' (Mac APFS / Windows NTFS / SMB 共享全兼容)。
 * 跨午夜 traceId 会落到两个日期子目录, PM 接受, 后续如想强制 bind 见 follow-up.
 */
function getTodayDate(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/** 当前日期子目录绝对路径 — 不递归创建, 调用方用 ensureLogDir() 负责 mkdir */
function getLogSubDir(): string {
  return path.join(LOG_DIR, getTodayDate())
}

export function getFlowLogPath(traceId: string): string {
  return path.join(getLogSubDir(), `flow-${traceId}.jsonl`)
}

/**
 * 启动时调一次，确保 logs/ 根 + 当天日期子目录都存在。
 * 建议在 server.listen() 之前调。
 */
export function ensureLogDir(): void {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true })
    }
    const subDir = getLogSubDir()
    if (!fs.existsSync(subDir)) {
      fs.mkdirSync(subDir, { recursive: true })
    }
  } catch (err: any) {
    console.warn(`[file-log] ensureLogDir failed: ${err.message}`)
  }
}

/**
 * 写一条 JSON Lines entry 到 logs/YYYY-MM-DD/flow-${traceId}.jsonl
 *
 * 设计要点：
 * - traceId 天然分文件，无需锁
 * - appendFileSync，标准 JSON Lines 格式（每行一个 JSON 对象，\n 结尾）
 * - 失败仅 console.warn，不抛异常（不能让日志故障阻塞业务）
 * - 单文件 > 50MB 自动切分到 flow-${traceId}-${seq}.jsonl (同日期子目录内)
 *
 * @param traceId  用户动作 traceId (空字符串/缺省时跳过写文件，兼容旧调用)
 * @param entry    JSON Lines 一行内容（任意可序列化对象）
 */
export function writeFlowLog(traceId: string, entry: Record<string, unknown>): void {
  if (!traceId) return  // 旧调用方式无 traceId → 不写文件
  if (!isFlowLogEnabled()) return

  try {
    const filePath = getFlowLogPath(traceId)
    let targetPath = filePath
    let seq = 0

    // 检查当前主文件大小，超限切分
    if (fs.existsSync(filePath)) {
      const { size } = fs.statSync(filePath)
      if (size >= MAX_FILE_BYTES) {
        seq = nextSequenceFor(traceId, filePath)
        // 切分序号文件继续落在当天日期子目录 (与 filePath 同 dir), path.dirname 自然正确
        targetPath = path.join(path.dirname(filePath), `flow-${traceId}-${seq}.jsonl`)
      }
    }

    // 确保日期子目录存在（运行时删 logs/ 后, 跨午夜首次写入时）
    const subDir = path.dirname(targetPath)
    if (!fs.existsSync(subDir)) {
      fs.mkdirSync(subDir, { recursive: true })
    }

    const line = JSON.stringify(entry) + '\n'
    fs.appendFileSync(targetPath, line, 'utf-8')
  } catch (err: any) {
    console.warn(`[file-log] writeFlowLog failed: ${err.message}`)
  }
}

/**
 * 计算下一个切分序号 — 简单扫一下日期子目录里现有 -N.jsonl 文件取最大 +1。
 * basePath 已位于日期子目录, dirname(basePath) = 当天日期子目录, 不再扫 LOG_DIR 根。
 */
function nextSequenceFor(traceId: string, basePath: string): number {
  try {
    const dir = path.dirname(basePath)
    const prefix = `flow-${traceId}-`
    const files = fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.jsonl'))
    let maxSeq = 0
    for (const f of files) {
      const m = f.slice(prefix.length, -'.jsonl'.length).match(/^(\d+)$/)
      if (m) {
        const n = parseInt(m[1], 10)
        if (n > maxSeq) maxSeq = n
      }
    }
    return maxSeq + 1
  } catch {
    return 1
  }
}
