/**
 * Agent Skills 加载服务
 *
 * Skill 文件约定:
 *   - 路径: skills/<agent_type>/<skill_name>/SKILL.md  → 自动归到 <agent_type> agent
 *   - 也支持: skills/<agent_type>/SKILL.md            → 自动归到 <agent_type> agent (单 skill 时)
 *   - 也支持: skills/<agent_type>/<skill_name>/SKILL.md 子目录(无限层级)
 *   - 覆盖: SKILL.md 的 YAML frontmatter 含 `agent: foo` 或 `agent: [foo, bar]` → 归到指定 agent
 *   - 跳过: 非 SKILL.md 命名的辅助文件(如 reference/character-prompt.md 等)
 *   - 例外: skills/_shared/<skill_name>/SKILL.md      → 所有 agent 都加载
 *
 * 使用流程:
 *   1. 在 skills/<agent_type>/ 下新建子目录, 写 SKILL.md
 *   2. 重启服务, agent 启动时会自动加载(无需改代码)
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const SKILLS_DIR = path.resolve(__dirname, '../../../skills')

/**
 * 解析 SKILL.md 的 YAML frontmatter(只支持顶层简单 key: value)
 * 例:
 *   ---
 *   name: storyboard-breaker
 *   description: 分镜拆解规范
 *   agent: storyboard_breaker
 *   ---
 */
function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith('---')) return {}
  const end = content.indexOf('\n---', 3)
  if (end === -1) return {}
  const block = content.slice(3, end)
  const out: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const m = line.match(/^([a-zA_]+):\s*(.+)$/)
    if (m) out[m[1].trim()] = m[2].trim()
  }
  return out
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content.trim()
  const end = content.indexOf('\n---', 3)
  if (end === -1) return content.trim()
  return content.slice(end + 4).trim()
}

function readSkillContent(skillId: string): string {
  const skillPath = path.join(SKILLS_DIR, skillId, 'SKILL.md')
  if (!fs.existsSync(skillPath)) return ''

  const raw = fs.readFileSync(skillPath, 'utf-8')
  const content = stripFrontmatter(raw)
  if (!content) return ''

  return [
    `## Skill: ${skillId}`,
    content,
  ].join('\n')
}

/** 扫描 SKILLS_DIR, 返回所有 SKILL.md 文件的路径列表(相对 SKILLS_DIR) */
function listSkillFiles(): string[] {
  const out: string[] = []
  if (!fs.existsSync(SKILLS_DIR)) return out

  function walk(dir: string, prefix: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(dir, e.name)
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        walk(full, rel)
      } else if (e.isFile() && e.name === 'SKILL.md') {
        out.push(rel.replace(/\\/g, '/').replace(/SKILL\.md$/, '').replace(/\/$/, ''))
      }
    }
  }
  walk(SKILLS_DIR, '')
  return out
}

/** 根据路径 + frontmatter 决定 skill 归哪些 agent */
function resolveSkillAgents(skillRel: string, frontmatter: Record<string, string>): string[] {
  const parts = skillRel.split('/')
  // 例: 'storyboard_breaker' | 'storyboard_breaker/wuxia' | '_shared/common' | 'X'
  const first = parts[0]

  // _shared → 所有 agent 都加载
  if (first === '_shared') return ['*']

  // frontmatter 覆盖(优先级最高):)
  const fm = frontmatter['agent']
  if (fm) {
    // 支持 agent: foo 或 agent: [foo, bar]
    return fm.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
  }

  // 路径前缀即 agent_type
  return [first]
}

/** 缓存: agent_type → joined skill content */
let cache: { key: string; result: string } | null = null

function buildAgentSkills(agentType: string): string {
  const skillFiles = listSkillFiles()
  const contents: string[] = []
  const loadedSkills: { id: string; bytes: number, preview: string }[] = []

  console.log(`[skills] buildAgentSkills('${agentType}') SKILLS_DIR=${SKILLS_DIR} found ${skillFiles.length} SKILL.md file(s) total`)

  for (const rel of skillFiles) {
    const fullPath = path.join(SKILLS_DIR, rel, 'SKILL.md')
    if (!fs.existsSync(fullPath)) continue
    const raw = fs.readFileSync(fullPath, 'utf-8')
    const fm = parseFrontmatter(raw)
    const agents = resolveSkillAgents(rel, fm)
    if (agents.includes(agentType) || agents.includes('*')) {
      const content = stripFrontmatter(raw)
      if (content) {
        contents.push([`## Skill: ${rel}`, content].join('\n'))
        loadedSkills.push({
          id: rel,
          bytes: content.length,
          preview: content.replace(/\s+/g, ' ').slice(0, 80),
        })
      }
    }
  }

  // Per-agent skill load log: shows which skills (if any) were injected into system prompt
  if (loadedSkills.length === 0) {
    console.log(`[skills]   agent=${agentType} → NO SKILLS LOADED (0 chars appended to prompt)`)
  } else {
    const totalBytes = loadedSkills.reduce((s, x) => s + x.bytes, 0)
    console.log(`[skills]   agent=${agentType} → loaded ${loadedSkills.length} skill(s), ${totalBytes} bytes total:`)
    for (const s of loadedSkills) {
      console.log(`[skills]     - ${s.id} (${s.bytes} chars): ${s.preview}…`)
    }
  }

  if (!contents.length) return ''

  return [
    '以下是该 Agent 专属的项目技能规范(SKILL.md)。',
    '不同 Agent 会加载不同 skill; 你只需要遵守当前注入的这些技能。',
    '你必须在不违背当前工具边界的前提下优先遵守这些规范; 若与用户明确要求冲突, 以用户要求为准。',
    '',
    contents.join('\n\n'),
  ].join('\n')
}

export function loadAgentSkills(agentType: string): string {
  // 简单缓存(每次启动扫一次即可)
  const cacheKey = agentType
  if (cache?.key === cacheKey) {
    return cache.result
  }
  const result = buildAgentSkills(agentType)
  cache = { key: cacheKey, result }
  return result
}

/** 调试用: 列出当前 agent 的所有 skill ID(相对路径) */
export function listAgentSkills(agentType: string): string[] {
  const skillFiles = listSkillFiles()
  return skillFiles.filter((rel) => {
    const fullPath = path.join(SKILLS_DIR, rel, 'SKILL.md')
    if (!fs.existsSync(fullPath)) return false
    const raw = fs.readFileSync(fullPath, 'utf-8')
    const fm = parseFrontmatter(raw)
    const agents = resolveSkillAgents(rel, fm)
    return agents.includes(agentType) || agents.includes('*')
  })
}
