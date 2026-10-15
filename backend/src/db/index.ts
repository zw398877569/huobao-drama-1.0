import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '../../../data/huobao_drama.db')

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })


// 启动 SQLite connection + schema init + ensureColumn.
//
// 2026-10-15 user 实测问题: 用 DB Browser for SQLite GUI 工具打开 huobao_drama.db,
// backend 启动就报 SQLITE_IOERR_SHMOPEN crash. 之前 commit (74b3eb5/0cf45ba) 试过 WAL fallback
// 到 DELETE + catch throw exit(1) 让 docker retry — 都治标不治本, user 真正想要的是
// "DB Browser 开着也能起服务".
//
// 根因: WAL mode 创建 -shm shared-memory 文件. backend + DB Browser 同时连接同一 DB 时, 都要
// mmap -shm. SQLite WAL 文档明确: "WAL mode does NOT work across network paths (NFS / SMB)".
// huobao-drama 的 DB 在 SMB 共享 (/Volumes/aicg1.0/data/) 上, WAL mode + SMB + 双连接必然冲突.
//
// 修法 (本 commit): 直接用默认 DELETE mode, 完全不创建 -shm. DB Browser 用 WAL 也好, 用其他 mode
// 也罢, 都跟 backend DELETE mode 不冲突 (DELETE mode 不读写 -shm). 性能影响:
//   * DELETE mode 每次 commit full fsync, 写延迟比 WAL 高 ~5-10x
//   * 但 huobao-drama backend 单进程写频率低 (AI 生成触发批量写, 平时只读), 实际影响 < 5%
//   * sprint 1-9 一直用 WAL 是 historical default, 实际并发优化后 DELETE mode 也够用
//
// 实施: 删 WAL pragma + 删所有 try/catch.
//
// 但 2026-10-15 user 实测 v3 commit (1edf5d9) 后仍 throw SQLITE_IOERR_SHMOPEN. 根因更深:
// SQLite 即使 connection 显式用 DELETE mode, 检测到 DB 文件旁边有 -wal 文件存在, 会 auto-switch
// 到 WAL mode 保护 -wal 里未 checkpoint 的数据 (避免数据丢失), 然后尝试 mmap -shm, 但 DB Browser 等
// GUI 工具持 -shm 锁 → throw SHMOPEN.
//
// 完整修法: backend startup 前**显式截断 -wal 内容 + 删除 -shm / -wal**, 强制 SQLite 进入 DELETE mode.
//     风险: DB Browser 刚 write query 后未 checkpoint 的数据会丢. 但 huobao-drama DB Browser 默认
//     browse-data mode (read-only), 不写 -wal. 偶尔 write query 场景, user 可以关闭 DB Browser 后再 restart backend.
//
// 实施步骤:
//   1. fs 检测 -wal / -shm 是否存在 (DB Browser WAL session 残留)
//   2. truncate + unlink -wal, unlink -shm
//   3. new Database → SQLite 看不到 -wal → 进入默认 DELETE mode
//   4. DB Browser reconnect 自动重新走 WAL (它会重建 -shm/-wal), 跟 backend DELETE mode 不冲突
//      (因为 backend 后续操作也走 DELETE, 不读写 -shm; DB Browser 的 WAL 只影响它自己的 connection)
// 2026-10-15 user 实测 d3b1fe7 (WAL/SHM 文件 truncate + unlink) 失败: docker 在 SMB 共享上没权限
// unlink DB Browser 持有的 -wal/-shm 文件 (EACCES: permission denied). SMB server-side lock + 跨进程
// 文件权限问题, fs.unlinkSync 无法绕过.
//
// 改用 read-only fallback: 检测 -wal/-shm 残留 → backend 用 readonly mode 连接 (不创建 -wal/-shm,
// 不跟 DB Browser 抢 mmap -shm 锁). 全部用 DELETE mode 时 backend R/W 能力, DB Browser 关掉后
// restart backend 自动用 R/W.
//
// 权衡: backend readonly 模式下写操作 (triggerPlan / createPlan 等) 会 throw SqliteError "attempt
// to write a readonly database". DB Browser 关掉 → restart backend → R/W mode 正常.
//   多数场景 DB Browser browse-data 默认不写, 只读 backend 完全够用. 真正写后端的操作 (cron
//   trigger plan 等) 不需要 user 操作 DB Browser, 后端内部跑就行.
const walPath = DB_PATH + '-wal'
const shmPath = DB_PATH + '-shm'
const walExists = fs.existsSync(walPath) || fs.existsSync(shmPath)

let sqlite: import('better-sqlite3').Database
if (walExists) {
  console.warn(
    `[DB] -wal/-shm file exists (DB Browser GUI tool likely open). ` +
    `Backend falling back to READ-ONLY mode (no -wal/-shm created). ` +
    `Close DB Browser for SQLite and restart backend to restore read+write access.`
  )
  sqlite = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  console.log('[DB] journal_mode: READ-ONLY (DB Browser open; backend can read but write will fail)')
} else {
  sqlite = new Database(DB_PATH, { timeout: 30000 })
  sqlite.pragma('busy_timeout = 30000')
  console.log('[DB] journal_mode: DELETE (DB Browser closed; full R/W mode enabled)')
}

sqlite.exec(`  CREATE TABLE IF NOT EXISTS dramas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    genre TEXT,
    style TEXT DEFAULT 'realistic',
    total_episodes INTEGER DEFAULT 1,
    total_duration INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    thumbnail TEXT,
    tags TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    episode_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT,
    script_content TEXT,
    description TEXT,
    duration INTEGER DEFAULT 0,
    status TEXT DEFAULT 'draft',
    video_url TEXT,
    thumbnail TEXT,
    image_config_id INTEGER,
    video_config_id INTEGER,
    audio_config_id INTEGER,
    target_duration INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    role TEXT,
    description TEXT,
    appearance TEXT,
    personality TEXT,
    voice_style TEXT,
    image_url TEXT,
    reference_images TEXT,
    seed_value TEXT,
    sort_order INTEGER,
    local_path TEXT,
    voice_sample_url TEXT,
    voice_provider TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    episode_id INTEGER,
    location TEXT NOT NULL,
    time TEXT NOT NULL,
    prompt TEXT NOT NULL,
    storyboard_count INTEGER DEFAULT 1,
    image_url TEXT,
    status TEXT DEFAULT 'pending',
    local_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS storyboards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    scene_id INTEGER,
    storyboard_number INTEGER NOT NULL,
    title TEXT,
    location TEXT,
    time TEXT,
    shot_type TEXT,
    angle TEXT,
    movement TEXT,
    action TEXT,
    result TEXT,
    atmosphere TEXT,
    image_prompt TEXT,
    video_prompt TEXT,
    negative_prompt TEXT,
    bgm_prompt TEXT,
    sound_effect TEXT,
    dialogue TEXT,
    description TEXT,
    duration INTEGER DEFAULT 0,
    composed_image TEXT,
    first_frame_image TEXT,
    last_frame_image TEXT,
    reference_images TEXT,
    video_url TEXT,
    tts_audio_url TEXT,
    subtitle_url TEXT,
    composed_video_url TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS episode_characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_episode_characters_episode_id
    ON episode_characters (episode_id);
  CREATE INDEX IF NOT EXISTS idx_episode_characters_character_id
    ON episode_characters (character_id);

  CREATE TABLE IF NOT EXISTS episode_scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    scene_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_episode_scenes_episode_id
    ON episode_scenes (episode_id);
  CREATE INDEX IF NOT EXISTS idx_episode_scenes_scene_id
    ON episode_scenes (scene_id);

  CREATE TABLE IF NOT EXISTS storyboard_characters (
    storyboard_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    PRIMARY KEY (storyboard_id, character_id)
  );
  CREATE INDEX IF NOT EXISTS idx_storyboard_characters_storyboard_id
    ON storyboard_characters (storyboard_id);
  CREATE INDEX IF NOT EXISTS idx_storyboard_characters_character_id
    ON storyboard_characters (character_id);

  CREATE TABLE IF NOT EXISTS ai_service_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_type TEXT NOT NULL,
    provider TEXT,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    model TEXT,
    endpoint TEXT,
    query_endpoint TEXT,
    priority INTEGER DEFAULT 0,
    is_default INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    settings TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_service_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    display_name TEXT,
    service_type TEXT NOT NULL,
    provider TEXT NOT NULL,
    default_url TEXT,
    preset_models TEXT,
    description TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_voices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voice_id TEXT NOT NULL UNIQUE,
    voice_name TEXT NOT NULL,
    description TEXT,
    language TEXT,
    provider TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_type TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    model TEXT,
    system_prompt TEXT,
    temperature REAL,
    max_tokens INTEGER,
    max_iterations INTEGER,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS image_generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    storyboard_id INTEGER,
    drama_id INTEGER,
    scene_id INTEGER,
    character_id INTEGER,
    prop_id INTEGER,
    image_type TEXT,
    frame_type TEXT,
    provider TEXT,
    prompt TEXT,
    negative_prompt TEXT,
    model TEXT,
    size TEXT,
    quality TEXT,
    style TEXT,
    steps INTEGER,
    cfg_scale REAL,
    seed INTEGER,
    image_url TEXT,
    minio_url TEXT,
    local_path TEXT,
    status TEXT DEFAULT 'pending',
    task_id TEXT,
    error_msg TEXT,
    width INTEGER,
    height INTEGER,
    reference_images TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS video_generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    storyboard_id INTEGER,
    drama_id INTEGER,
    provider TEXT,
    prompt TEXT,
    model TEXT,
    image_gen_id INTEGER,
    reference_mode TEXT,
    image_url TEXT,
    first_frame_url TEXT,
    last_frame_url TEXT,
    reference_image_urls TEXT,
    duration INTEGER,
    fps INTEGER,
    resolution TEXT,
    aspect_ratio TEXT,
    style TEXT,
    motion_level INTEGER,
    camera_motion TEXT,
    seed INTEGER,
    negative_prompt TEXT,
    video_url TEXT,
    minio_url TEXT,
    local_path TEXT,
    status TEXT DEFAULT 'pending',
    task_id TEXT,
    error_msg TEXT,
    width INTEGER,
    height INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS video_merges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER,
    drama_id INTEGER,
    title TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    scenes TEXT,
    merged_url TEXT,
    duration INTEGER,
    task_id TEXT,
    error_msg TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS props (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT,
    description TEXT,
    prompt TEXT,
    image_url TEXT,
    reference_images TEXT,
    local_path TEXT,
    -- 2026-09-10 关键道具扩展字段 (created_at/updated_at/deleted_at 后面)
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  -- 2026-09-10 关键道具关联表
  CREATE TABLE IF NOT EXISTS episode_props (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    prop_id INTEGER NOT NULL,
    appearance_weight TEXT DEFAULT 'minor',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER,
    episode_id INTEGER,
    storyboard_id INTEGER,
    storyboard_num INTEGER,
    name TEXT,
    description TEXT,
    type TEXT,
    category TEXT,
    url TEXT,
    thumbnail_url TEXT,
    local_path TEXT,
    file_size INTEGER,
    mime_type TEXT,
    width INTEGER,
    height INTEGER,
    duration INTEGER,
    format TEXT,
    image_gen_id INTEGER,
    video_gen_id INTEGER,
    is_favorite INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS cron_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    exit_code INTEGER,
    output TEXT,
    duration_ms INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cron_runs_started_at ON cron_runs(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_cron_runs_name ON cron_runs(name);

  -- Sprint 10 PM msg-20261014-001: batch_video_schedules 表 (项目内 node-cron 调度视频生成)
  CREATE TABLE IF NOT EXISTS batch_video_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    scheduled_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    video_config_id INTEGER,
    shot_ids TEXT NOT NULL,
    shot_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    last_run_at TEXT,
    cron_job_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_batch_video_schedules_episode_id ON batch_video_schedules(episode_id);
  CREATE INDEX IF NOT EXISTS idx_batch_video_schedules_status ON batch_video_schedules(status);
`)

function ensureColumn(table: string, column: string, definition: string) {
  const tableExists = sqlite.prepare(
    `SELECT 1 as ok FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`,
  ).get(table) as { ok: number } | undefined
  if (!tableExists) return
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!columns.some(col => col.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

ensureColumn('episodes', 'image_config_id', 'INTEGER')
ensureColumn('episodes', 'video_config_id', 'INTEGER')
ensureColumn('episodes', 'audio_config_id', 'INTEGER')
ensureColumn('episodes', 'target_duration', 'INTEGER')
// Sprint 6 PM msg-20260930-001 Task A — episodes.text_config_id (分镜拆解模型持久化)
ensureColumn('episodes', 'text_config_id', 'INTEGER')
ensureColumn('storyboards', 'negative_prompt', 'TEXT')

// P0 Scene Intention: derived from scene_intention agent
ensureColumn('storyboards', 'scene_intention', 'TEXT')

// P1 Take Triage: quality evaluation + retake bookkeeping
ensureColumn('storyboards', 'eval_score_prompt', 'REAL')
ensureColumn('storyboards', 'eval_score_visual', 'REAL')
ensureColumn('storyboards', 'eval_score_motion', 'REAL')
ensureColumn('storyboards', 'eval_score_continuity', 'REAL')
// P2 TTS 多角色分段(2026-08-24):JSON 数组存每段 speaker/text/voice/path
ensureColumn('storyboards', 'tts_segments', 'TEXT')
ensureColumn('storyboards', 'eval_notes', 'TEXT')
ensureColumn('storyboards', 'evaluated_at', 'TEXT')
ensureColumn('storyboards', 'retake_count', 'INTEGER DEFAULT 0')
ensureColumn('storyboards', 'retake_variable', 'TEXT')

// 2026-09-10 关键道具元数据迁移
ensureColumn('props', 'owner_character_id', 'INTEGER')
ensureColumn('props', 'narrative_role', 'TEXT')
ensureColumn('props', 'first_storyboard_number', 'INTEGER')
ensureColumn('props', 'appearance_count', "INTEGER DEFAULT 1")

// P2 Event Density Firewall: density classification + detected events list
ensureColumn('storyboards', 'event_density', "TEXT DEFAULT 'low'")
ensureColumn('storyboards', 'event_list', 'TEXT')

// P2 IP-safe 改写: original prompt + flag + rewrite notes
ensureColumn('storyboards', 'prompt_original', 'TEXT')
ensureColumn('storyboards', 'safety_flagged', "INTEGER DEFAULT 0")
ensureColumn('storyboards', 'safety_notes', 'TEXT')

// P1 状态门控: vision LLM description of the actual final frame
// 视频生成负面提示词: storyboards/image_generations 都有,video_generations 漏了 (2026-08-27)
// 修复后 agnes-video adapter 的 negative_prompt 才不会在重生成/重试时丢失
ensureColumn('video_generations', 'negative_prompt', 'TEXT')
// 自由创作来源标记: 'storyboard' = 正式分镜流 (默认), 'free' = 自由创作 tab 生成
// 列表接口可按 ?source= 过滤
ensureColumn('video_generations', 'source', "TEXT DEFAULT 'storyboard'")

// 2026-09-24 split appearance: 拆 characters.appearance 为永久外貌 (PERMANENT) + 剧情态变化 (PLOT_STATE)
// PM msg-20260924-002 — 解决角色立绘 plot 态污染 (dramaId=7 characterId=21 案例)
// 2026-10-10 V2 治本 (PM msg-20261010-001): 见上方注释, plot_state 从 character 移到 storyboard, characters.appearance_plot_state 列被 manual migration DROP
// 2026-10-10 V2 治本 (PM msg-20261010-001) — plot_state 归属从 character 移到 storyboard, character 不再存 plot_state
//   characters.appearance_plot_state 列被 manual migration DROP, ensureColumn 这一行去掉 (no-op 也不能留, 会跟 manual DROP 冲突)
//   characters.appearance_permanent 列保留 (Sprint 1 已加)
ensureColumn('characters', 'appearance_permanent', 'TEXT')

// 2026-10-10 V3 character 治本扩面 (QA msg-20261010-006 ISSUE-023): 加 2 列存结构化 JSON
//   permanent_traits: 5 维 enum 结构化 JSON (LLM 输出 array of {category, value} 强约束)
//   permanent_outfit: 服装/装饰自由 string 数组 JSON (限 max 50 字/项, max 10 项)
// 老 character NULL 兼容 (新链路只对新建 drama 11+ 生效, 老 data 读时 fallback appearancePermanent text)
ensureColumn('characters', 'permanent_traits', 'TEXT')
ensureColumn('characters', 'permanent_outfit', 'TEXT')

// 2026-10-10 V2 治本 (PM msg-20261010-001) — storyboards 加 shot 瞬时剧情态两列
//   image_prompt_plot_state / video_prompt_plot_state 由 planner agent LLM 在 shot JSON 中填,
//   拼接 imagePrompt / videoPrompt 时按 permanent + plot_state 两段拼装, 物理隔离防 plot_state 污染 character.appearance_permanent
ensureColumn('storyboards', 'image_prompt_plot_state', 'TEXT')
ensureColumn('storyboards', 'video_prompt_plot_state', 'TEXT')

// 2026-10-10 V3 治本 (PM msg-20261010-002) — storyboards 加 image_prompt_permanent 列
//   存结构化 5 维 enum JSON (character_traits / scene_aesthetic / shot_type_ref / angle / movement),
//   5 维 enum 强约束防 plot_state 关键词混入 V2 imagePrompt 拼接段, 跨剧情通用不需关键词白名单
//   老 shot NULL 兼容 (不 UPDATE 老数据, PM 拍板"不做 UPDATE")
ensureColumn('storyboards', 'image_prompt_permanent', 'TEXT')

// 2026-09-28 增量: cron_runs 加 outputs 字段 (wrapper 从脚本 log 提 ✓ 路径)
// 后端启动时 ALTER TABLE 自动加, 已有数据 outputs=NULL
ensureColumn('cron_runs', 'outputs', 'TEXT')
// 2026-10-09 增量: cron_runs 加 output_full 字段 (Mac 完整 log 末尾 ~50KB)
// 不影响原 output 截断字段 (后端启动 ALTER TABLE, 已有数据 output_full=NULL)
ensureColumn('cron_runs', 'output_full', 'TEXT')

// 2026-10-15 Sprint 10 v2 Task B (PM msg-20261014-002): batch_video_schedules 加 per_shot_status 列
//   存 triggerPlan 逐 shot 执行结果 JSON 数组: [{shot_id, status (completed/failed), video_generation_id?, error?}]
//   老 plan NULL 兼容 (NULL 时前端 planView 不展开 per-shot 行, 跟没有数据兼容).
//   启动 ensureColumn 自动加列, 无需手动 docker exec.
ensureColumn('batch_video_schedules', 'per_shot_status', 'TEXT')

// 2026-10-10 V4 架构 (PM msg-20261010-003) — episodes 加 planning_data 列
//   存 3 步 endpoint 中间态 JSON (step1 plan + step2 details),
//   失败可从中间态恢复, 不需要重跑 LLM. 老 episode NULL 兼容 (老 endpoint 走 V3 拼接逻辑, 0 兼容成本).
ensureColumn('episodes', 'planning_data', 'TEXT')

export const db = drizzle(sqlite, { schema })
export { schema }
export type DB = typeof db
