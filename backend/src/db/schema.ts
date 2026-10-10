/**
 * Drizzle schema — 精确匹配现有 SQLite 数据库列名
 * 从 PRAGMA table_info() 逆向生成
 */
import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core'

export const dramas = sqliteTable('dramas', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  description: text('description'),
  genre: text('genre'),
  style: text('style').default('realistic'),
  // 2026-09-23 PM msg-20260923-002 fix #2: 角色美学独立维度
  //   与 drama.style (剧集整体美术风格) 分离:
  //   - drama.style: 写实/动漫/电影感 (控制画风/镜头语言)
  //   - characterAesthetic: east-asian / western / neutral (控制角色脸型/肤色/发色)
  //   nullable, 默认 null → 代码 fallback 'neutral' → 不注入 token, 现状兼容
  characterAesthetic: text('character_aesthetic'),
  totalEpisodes: integer('total_episodes').default(1),
  totalDuration: integer('total_duration').default(0),
  status: text('status').notNull().default('draft'),
  thumbnail: text('thumbnail'),
  tags: text('tags'),
  metadata: text('metadata'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const episodes = sqliteTable('episodes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  episodeNumber: integer('episode_number').notNull(),
  title: text('title').notNull(),
  content: text('content'),
  scriptContent: text('script_content'),
  description: text('description'),
  duration: integer('duration').default(0),
  status: text('status').default('draft'),
  videoUrl: text('video_url'),
  thumbnail: text('thumbnail'),
  imageConfigId: integer('image_config_id'),
  videoConfigId: integer('video_config_id'),
  audioConfigId: integer('audio_config_id'),
  // Sprint 6 PM msg-20260930-001 Task A — 分镜拆解模型选择持久化 (跟 image/video/audio config 风格一致)
  textConfigId: integer('text_config_id'),
  // PM 派单 msg-20260920-004 Step 3.D: user-set target duration (s), null = estimator fallback
  targetDuration: integer('target_duration'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const characters = sqliteTable('characters', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  name: text('name').notNull(),
  role: text('role'),
  description: text('description'),
  // 永久外貌 (PERMANENT) — Sprint 1 ADD COLUMN, V2 治本 (msg-20261010-001) 后由 manual migration
  //   ALTER TABLE characters RENAME COLUMN appearance TO appearance_permanent 对齐列名。
  //   禁含 plot_state 关键词 (反转/狂笑/按下按钮/后期突变/诡异/死亡/灵宠/血契 等),
  //   仅允许: age / face / hair / body / outfit / demeanor。
  appearancePermanent: text('appearance_permanent'),
  personality: text('personality'),
  voiceStyle: text('voice_style'),
  imageUrl: text('image_url'),
  referenceImages: text('reference_images'),
  seedValue: text('seed_value'),
  sortOrder: integer('sort_order'),
  localPath: text('local_path'),
  voiceSampleUrl: text('voice_sample_url'),
  voiceProvider: text('voice_provider'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

// Episode-Character many-to-many
export const episodeCharacters = sqliteTable('episode_characters', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  characterId: integer('character_id').notNull(),
  createdAt: text('created_at').notNull(),
})

// Episode-Scene many-to-many
export const episodeScenes = sqliteTable('episode_scenes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  sceneId: integer('scene_id').notNull(),
  createdAt: text('created_at').notNull(),
})

// Episode-Prop many-to-many (2026-09-10 关键道具关联)
export const episodeProps = sqliteTable('episode_props', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  propId: integer('prop_id').notNull(),
  // 该 prop 在本集里的出现强度 (1-3 镜头 = minor, 4-8 = major, 9+ = critical)
  appearanceWeight: text('appearance_weight').default('minor'),
  createdAt: text('created_at').notNull(),
})

export const scenes = sqliteTable('scenes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  episodeId: integer('episode_id'),
  location: text('location').notNull(),
  time: text('time').notNull(),
  prompt: text('prompt').notNull(),
  storyboardCount: integer('storyboard_count').default(1),
  imageUrl: text('image_url'),
  status: text('status').default('pending'),
  localPath: text('local_path'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const storyboards = sqliteTable('storyboards', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  sceneId: integer('scene_id'),
  storyboardNumber: integer('storyboard_number').notNull(),
  title: text('title'),
  location: text('location'),
  time: text('time'),
  shotType: text('shot_type'),
  angle: text('angle'),
  movement: text('movement'),
  action: text('action'),
  result: text('result'),
  atmosphere: text('atmosphere'),
  imagePrompt: text('image_prompt'),
  // shot 瞬时剧情态 (PLOT_STATE, per-shot episode window) — V2 治本 (msg-20261010-001) 新列。
  //   拼接 imagePrompt 时跟 LLM 输出的 image_prompt_permanent 段拼装,
  //   数据隔离后 LLM 不可能再把 plot_state 误塞进 character.appearance_permanent。
  imagePromptPlotState: text('image_prompt_plot_state'),
  videoPrompt: text('video_prompt'),
  // shot 视频瞬时剧情态 (PLOT_STATE, 5秒视频窗口内的动作变化)。
  videoPromptPlotState: text('video_prompt_plot_state'),
  // V3 治本核心列 (PM msg-20261010-002): 存结构化 5 维 enum JSON。
  //   结构: { character_traits: [{category: 'age'|'face'|'hair'|'body'|'outfit', value: string}],
  //           scene_aesthetic: [string], shot_type_ref: '全景'|'中景'|'近景'|'特写',
  //           angle: string, movement: string }
  //   5 维 enum 强约束 (LLM 想写 '深爱豆豆胜过自己' 因没匹配 category 被 zod reject,
  //   不需关键词白名单, 跨剧情通用)。老 shot NULL 兼容 (V3 起的 shot 才写)。
  imagePromptPermanent: text('image_prompt_permanent'),
  negativePrompt: text('negative_prompt'),
  bgmPrompt: text('bgm_prompt'),
  soundEffect: text('sound_effect'),
  dialogue: text('dialogue'),
  description: text('description'),
  duration: integer('duration').default(0),
  composedImage: text('composed_image'),
  firstFrameImage: text('first_frame_image'),
  lastFrameImage: text('last_frame_image'),
  referenceImages: text('reference_images'),
  videoUrl: text('video_url'),
  ttsAudioUrl: text('tts_audio_url'),
  // P2 TTS 多角色分段:JSON [{ speaker, text, voice, isNarrator, segmentPath }](2026-08-24)
  ttsSegments: text('tts_segments'),
  subtitleUrl: text('subtitle_url'),
  composedVideoUrl: text('composed_video_url'),
  status: text('status').default('pending'),
  // P0: Scene Intention field
  sceneIntention: text('scene_intention'),
  // Derived intention + visual strategy for the shot
  // P1 Take Triage: 4-dim quality evaluation (0-10) + retake bookkeeping
  evalScorePrompt: real('eval_score_prompt'),
  evalScoreVisual: real('eval_score_visual'),
  evalScoreMotion: real('eval_score_motion'),
  evalScoreContinuity: real('eval_score_continuity'),
  evalNotes: text('eval_notes'),
  evaluatedAt: text('evaluated_at'),
  retakeCount: integer('retake_count').default(0),
  retakeVariable: text('retake_variable'),
  // P2 Event Density Firewall: number of independent events detected in video_prompt
  // 1-2 = low, 3-4 = medium, 5+ = high (consider splitting into multiple shots)
  eventDensity: text('event_density').default('low'),
  eventList: text('event_list'), // JSON array of detected event descriptions
  // P2 IP-safe 改写: pre-flight rewrite of IP / celebrity / brand references
  // before the prompt is sent to the image / video provider. promptOriginal
  // keeps the user's literal text for diff display; safetyNotes is a JSON
  // array describing each rewrite.
  promptOriginal: text('prompt_original'),
  safetyFlagged: integer('safety_flagged').default(0),
  safetyNotes: text('safety_notes'),
  // (2026-08-29 removed: P1 状态门控 schema 字段 observed_final_state/observed_final_state_at。
  //  跨镜头连续性靠 storyboard_breaker agent prompt 自身的 vault-aligned 规则实现,
  //  不再走 "抽最后一帧 + vision LLM 描述" 这条路径。旧 DB 的两列会保留但不再写入。)
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const storyboardCharacters = sqliteTable('storyboard_characters', {
  storyboardId: integer('storyboard_id').notNull(),
  characterId: integer('character_id').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.storyboardId, table.characterId] }),
}))

export const aiServiceConfigs = sqliteTable('ai_service_configs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  serviceType: text('service_type').notNull(),
  provider: text('provider'),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  apiKey: text('api_key').notNull(),
  model: text('model'),
  endpoint: text('endpoint'),
  queryEndpoint: text('query_endpoint'),
  priority: integer('priority').default(0),
  isDefault: integer('is_default', { mode: 'boolean' }).default(false),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  settings: text('settings'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  // 注意: 此表无 deleted_at
})

export const aiServiceProviders = sqliteTable('ai_service_providers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  displayName: text('display_name'),
  serviceType: text('service_type').notNull(),
  provider: text('provider').notNull(),
  defaultUrl: text('default_url'),
  presetModels: text('preset_models'),
  description: text('description'),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const aiVoices = sqliteTable('ai_voices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  voiceId: text('voice_id').notNull().unique(),   // MiniMax voice_id
  voiceName: text('voice_name').notNull(),         // 中文名
  description: text('description'),                // 描述数组 JSON
  language: text('language'),                     // 语言标签
  provider: text('provider').notNull(),           // minimax
  createdAt: text('created_at').notNull(),
})

export const agentConfigs = sqliteTable('agent_configs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  agentType: text('agent_type').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  model: text('model'),
  systemPrompt: text('system_prompt'),
  temperature: real('temperature'),
  maxTokens: integer('max_tokens'),
  maxIterations: integer('max_iterations'),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const imageGenerations = sqliteTable('image_generations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyboardId: integer('storyboard_id'),
  dramaId: integer('drama_id'),
  sceneId: integer('scene_id'),
  characterId: integer('character_id'),
  propId: integer('prop_id'),
  imageType: text('image_type'),
  frameType: text('frame_type'),
  provider: text('provider'),
  prompt: text('prompt'),
  negativePrompt: text('negative_prompt'),
  model: text('model'),
  size: text('size'),
  quality: text('quality'),
  style: text('style'),
  steps: integer('steps'),
  cfgScale: real('cfg_scale'),
  seed: integer('seed'),
  imageUrl: text('image_url'),
  minioUrl: text('minio_url'),
  localPath: text('local_path'),
  status: text('status').default('pending'),
  taskId: text('task_id'),
  errorMsg: text('error_msg'),
  width: integer('width'),
  height: integer('height'),
  referenceImages: text('reference_images'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
})

export const videoGenerations = sqliteTable('video_generations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storyboardId: integer('storyboard_id'),
  dramaId: integer('drama_id'),
  // 'storyboard' = 正式分镜流 (默认), 'free' = 自由创作 tab 生成
  source: text('source').default('storyboard'),
  provider: text('provider'),
  prompt: text('prompt'),
  model: text('model'),
  imageGenId: integer('image_gen_id'),
  referenceMode: text('reference_mode'),
  imageUrl: text('image_url'),
  firstFrameUrl: text('first_frame_url'),
  lastFrameUrl: text('last_frame_url'),
  referenceImageUrls: text('reference_image_urls'),
  duration: integer('duration'),
  fps: integer('fps'),
  resolution: text('resolution'),
  aspectRatio: text('aspect_ratio'),
  style: text('style'),
  motionLevel: integer('motion_level'),
  cameraMotion: text('camera_motion'),
  seed: integer('seed'),
  negativePrompt: text('negative_prompt'),
  videoUrl: text('video_url'),
  minioUrl: text('minio_url'),
  localPath: text('local_path'),
  status: text('status').default('pending'),
  taskId: text('task_id'),
  errorMsg: text('error_msg'),
  width: integer('width'),
  height: integer('height'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
  deletedAt: text('deleted_at'),
})

export const videoMerges = sqliteTable('video_merges', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id'),
  dramaId: integer('drama_id'),
  title: text('title'),
  provider: text('provider'),
  model: text('model'),
  status: text('status').default('pending'),
  scenes: text('scenes'), // JSON
  mergedUrl: text('merged_url'),
  duration: integer('duration'),
  taskId: text('task_id'),
  errorMsg: text('error_msg'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
  deletedAt: text('deleted_at'),
})

export const props = sqliteTable('props', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  name: text('name').notNull(),
  type: text('type'),
  description: text('description'),
  prompt: text('prompt'),
  imageUrl: text('image_url'),
  referenceImages: text('reference_images'),
  localPath: text('local_path'),
  // 2026-09-10: 关键道具元数据 (用于 H3 Ref2V 跨镜头一致性)
  ownerCharacterId: integer('owner_character_id'),
  narrativeRole: text('narrative_role'),         // 信物 / 武器 / 随身工具 / 纪念品 / ...
  firstStoryboardNumber: integer('first_storyboard_number'),
  appearanceCount: integer('appearance_count').default(1),   // 跨集出现总次数, 累加
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const assets = sqliteTable('assets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id'),
  episodeId: integer('episode_id'),
  storyboardId: integer('storyboard_id'),
  storyboardNum: integer('storyboard_num'),
  name: text('name'),
  description: text('description'),
  type: text('type'),
  category: text('category'),
  url: text('url'),
  thumbnailUrl: text('thumbnail_url'),
  localPath: text('local_path'),
  fileSize: integer('file_size'),
  mimeType: text('mime_type'),
  width: integer('width'),
  height: integer('height'),
  duration: integer('duration'),
  format: text('format'),
  imageGenId: integer('image_gen_id'),
  videoGenId: integer('video_gen_id'),
  isFavorite: integer('is_favorite', { mode: 'boolean' }).default(false),
  viewCount: integer('view_count').default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})


// cron 任务监控 — 外部 launchd 任务 wrapper 上报 (来自 ~/bin/task-runner.sh)
// 与项目内任务 (logTask*) 隔离, 独立表, 不影响任何已有表
export const cronRuns = sqliteTable('cron_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: text('run_id').notNull().unique(),
  name: text('name').notNull(),
  status: text('status').notNull(),
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at'),
  exitCode: integer('exit_code'),
  output: text('output'),
  durationMs: integer('duration_ms'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  // 2026-09-28 增量: 产出物路径数组 (JSON 序列化), wrapper 从 log "✓ label: /abs/path" 提取
  // 跨平台可读: dashboard / 后端统一消费这一列, 替代 grep log 的工作流
  outputs: text('outputs'),
  // 2026-10-09 增量: 完整 log 文本 (末尾 ~50KB), 跟 output (截 2000 字) 互补
  // 不影响原 output 字段, 仅在 wrapper 上传 log 后填
  outputFull: text('output_full'),
})

// face-archive 同步表 — 2026-09-29 Sprint 5 P0 (face-archive 集成)
// 数据源: ~/Obsidian/cronTask/aicg-demo/data/face-types.json (Mac cron 任务产出, 不进 git repo)
// 注入位置:
//   - src/routes/characters.ts imagePrompt 拼接 (code-side 1-2 条精选)
//   - src/agents/tools/grid-prompt-tools.ts generateCharacterPrompt (LLM-side few-shot 5-8 条)
// 关联表/字段: 不存 character_id, 无外键 — face-archive 是风格参考库, 不绑定具体 character.
// 多剧共用同一张表 (跨剧多样性 soft constraint 由 ORDER BY RANDOM() + few-shot 软约束保证).
// 索引在 manual-2026-09-29-face-type-entries.sql 里建 (4 个: factor_external unique + 3 查询索引).
export const faceTypeEntries = sqliteTable('face_type_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  factor: text('factor').notNull(),
  externalId: text('external_id').notNull(),
  name: text('name').notNull(),
  nameEn: text('name_en'),
  data: text('data').notNull(),
  promptTokens: text('prompt_tokens'),
  gender: text('gender'),
  source: text('source').notNull().default('face-archive'),
  archivedAt: text('archived_at').notNull(),
  syncedAt: text('synced_at').notNull(),
  createdAt: text('created_at').notNull(),
})

// Sprint 6 PM msg-20260930-001 Task A — episodes.text_config_id
//   跟 image/video/audio config_id 风格一致 (持久化分镜拆解模型选择, 用户测 DeepSeek)
//   ensureColumn 自动 ALTER TABLE 加列 (backend/src/db/index.ts 启动时跑)
export {}
