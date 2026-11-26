<template>
  <div class="hot-page">
    <header class="card hot-head">
      <div class="hot-head-row">
        <div>
          <div class="hot-title">热点看板</div>
          <div class="dim mono hot-meta">
            数据日期 {{ currentDate || '-' }} · 生成于 {{ generatedAt || '-' }}
          </div>
        </div>
        <div class="hot-nav">
          <button class="btn btn-sm" :disabled="!prevDate" title="更早一天" @click="goDate(prevDate)">←</button>
          <select class="input hot-select" :value="currentDate" @change="onPickDate">
            <option v-for="d in availableDates" :key="d" :value="d">{{ d }}</option>
            <option v-if="!availableDates.length" value="">（无）</option>
          </select>
          <button class="btn btn-sm" :disabled="!nextDate" title="更新一天" @click="goDate(nextDate)">→</button>
        </div>
      </div>
    </header>

    <!-- ① 加载中 -->
    <div v-if="loading" class="card hot-state">加载中…</div>
    <!-- ② 请求失败 -->
    <div v-else-if="error" class="card hot-state hot-error">
      <span>加载失败：{{ error }}</span>
      <button class="btn btn-sm" @click="load()">重试</button>
    </div>
    <!-- ③ 空数据 (★ 后端【确实没有】数据 —— 与上面的"加载失败"是两回事, 别混) -->
    <div v-else-if="empty" class="card hot-state">
      {{ emptyMsg || '还没有 daily-hot 数据 —— 等 M3 上的 daily-hot 跑完后上报上来。' }}
    </div>

    <template v-else>
      <!-- ★ 单 qa-20261126-003: 8 个分区两两并排 (只并排【分区】, 分区内部的榜单组仍上下堆叠) -->
      <div class="hot-grid">
        <section v-for="s in sections" :key="s.key" class="hot-section">
          <div class="card hot-sec-head">
            <span class="hot-sec-title">{{ s.label }}</span>
            <span class="dim">
              榜单 {{ countItems(s) }} 条<span v-if="sourceCount(s)"> · 数据源 {{ sourceCount(s) }}</span>
            </span>
          </div>

          <div v-if="!groupsOf(s).length" class="card hot-empty">该分区暂无数据</div>

          <div v-for="g in groupsOf(s)" :key="g.label" class="card hot-group">
            <div class="hot-group-title">
              <span>{{ g.label }}</span>
              <span class="dim mono">{{ g.note || `${g.items.length} 条` }}</span>
            </div>
            <ol v-if="g.items.length" class="hot-list">
              <!-- ★ 单 243 T1: 收起态只渲染前 10 条, 展开态渲染全部 (后端给多少显示多少) -->
              <li v-for="(it, i) in visibleItems(s, g)" :key="i" class="hot-item">
                <a v-if="linkOf(it)" class="hot-link" :href="linkOf(it)" target="_blank" rel="noopener">{{ titleOf(it) }}</a>
                <span v-else class="hot-title-plain">{{ titleOf(it) }}</span>
                <span v-if="subOf(it)" class="dim hot-sub">{{ subOf(it) }}</span>
              </li>
            </ol>
            <div v-else class="dim hot-group-empty">（无条目）</div>
            <!-- 每个组一个按钮, 各组状态互相独立 (本单不做全局总开关 / 不做状态持久化) -->
            <button
              class="hot-toggle"
              :class="{ 'hot-toggle-plain': g.items.length <= COLLAPSE_LIMIT }"
              :disabled="g.items.length <= COLLAPSE_LIMIT"
              @click="toggleGroup(s, g)"
            >
              {{ toggleLabel(s, g) }}
            </button>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { dailyHotAPI } from '~/composables/useApi'
// ★ 单 240: 解包/空数据判定【只有这一处实现】(utils/hot-dashboard.ts) —— 首次加载与切换日期共用
import { buildHotSections, unpackHot, isNoDataError, hasAnyBoard } from '~/utils/hot-dashboard'
import type { Group, Section } from '~/utils/hot-dashboard'

/**
 * ★ Sprint 58 (PM msg-20261123-227) + 返工 (PM msg-20261126-240): daily-hot 数据看板 /hot
 *   ★ 分区映射放在 utils/hot-dashboard.ts (纯函数) → 页面只负责渲染, 且能离线断言不串 key
 */
const sections = buildHotSections()

const loading = ref(false)
const error = ref('')
const raw = ref<any>(null)          // 分区数据容器 (boards)
const empty = ref(false)            // ★ 后端【确实没数据】(与"加载失败"区分)
const emptyMsg = ref('')
const currentDate = ref('')
const generatedAt = ref('')
const availableDates = ref<string[]>([])

/**
 * ★ 取数 + 应用状态【只有这一处】—— 首次加载与切换日期共用同一条路径
 *   (AC5: 以前两处各写了一份同样的解包, 改一处漏一处就会出现"首次能出、切日期又空")
 */
async function load(date?: string) {
  loading.value = true
  error.value = ''
  empty.value = false
  emptyMsg.value = ''
  try {
    const resp: any = await dailyHotAPI.get(date)
    const p = unpackHot(resp)
    raw.value = p.boards
    currentDate.value = p.date || currentDate.value
    generatedAt.value = p.generatedAt
    if (p.availableDates.length) availableDates.value = p.availableDates
    if (!hasAnyBoard(p.boards)) {
      // 后端确实没数据 (文件在但没有任何分区) → 空状态, 不是错误
      raw.value = null
      empty.value = true
      emptyMsg.value = `没有 ${p.date} 的 daily-hot 数据 —— 等 M3 上的 daily-hot 跑完后上报上来。`
    }
  } catch (e: any) {
    const msg = String(e?.message || '未知错误')
    raw.value = null
    if (isNoDataError(msg)) {
      // ★ 后端确实没数据 → 空状态 (与"取数/解包失败"必须能区分)
      empty.value = true
      emptyMsg.value = date
        ? `没有 ${date} 的 daily-hot 数据（可能已被 30 天清理）。`
        : '还没有 daily-hot 数据 —— 等 M3 上的 daily-hot 跑完后上报上来。'
    } else {
      // ★ 形状不对 / 解包失败 / 接口报错 → 显式报错 (别再显示成空状态)
      error.value = msg
    }
  } finally {
    loading.value = false
  }
}

function onPickDate(e: any) {
  const d = String(e?.target?.value || '')
  if (!d) return
  goDate(d)
}

function goDate(d: string) {
  if (!d) return
  return load(d)
}

/* ── T1: 每个榜单组默认收缩 10 条, 点开展示全部 (各组独立) ── */
const COLLAPSE_LIMIT = 10
/** 已展开的组: key = `${分区key}::${组label}` */
const expandedGroups = ref<Record<string, boolean>>({})

function groupKey(s: Section, g: Group): string {
  return `${s.key}::${g.label}`
}
function isExpanded(s: Section, g: Group): boolean {
  return !!expandedGroups.value[groupKey(s, g)]
}
function toggleGroup(s: Section, g: Group) {
  if (g.items.length <= COLLAPSE_LIMIT) return
  const k = groupKey(s, g)
  expandedGroups.value = { ...expandedGroups.value, [k]: !expandedGroups.value[k] }
}
/** 收起态只给前 10 条; 展开态给全部 (不设固定上限) */
function visibleItems(s: Section, g: Group): any[] {
  if (isExpanded(s, g)) return g.items
  return g.items.slice(0, COLLAPSE_LIMIT)
}
function toggleLabel(s: Section, g: Group): string {
  if (!g.items.length) return '无条目'
  if (g.items.length <= COLLAPSE_LIMIT) return `已全部显示 ${g.items.length} 条`
  return isExpanded(s, g) ? '收起' : `展开全部 ${g.items.length} 条`
}

/* ── 分区工具 ── */
function groupsOf(s: Section): Group[] {
  const d = raw.value || {}
  let gs: Group[] = []
  try { gs = s.groups(d) || [] } catch { gs = [] }
  return gs.filter((g) => g && (g.items?.length || g.note))
}
function countItems(s: Section): number {
  return groupsOf(s).reduce((n, g) => n + (g.items?.length || 0), 0)
}
function sourceCount(s: Section): number {
  const sc = raw.value?.sources_count || {}
  let n = 0
  for (const k of s.sourceKeys) {
    const v = sc[k]
    if (typeof v === 'number') n += v
  }
  return n
}

/* ── 条目渲染 (各榜字段不同 → 通用取值, 避免写 8 套模板) ── */
function titleOf(it: any): string {
  return it?.title || it?.name || it?.tag || it?.keyword || it?.series_id || '(无标题)'
}
function linkOf(it: any): string {
  if (it?.url) return it.url
  if (it?.detail_url) return it.detail_url
  // github_trending 的 name 形如 'owner/repo' → 拼仓库链接
  if (typeof it?.name === 'string' && it.name.includes('/')) return `https://github.com/${it.name}`
  return ''
}
function subOf(it: any): string {
  const b: string[] = []
  if (it?.author) b.push(it.author)
  if (it?.fans) b.push(`粉丝 ${it.fans}`)
  if (it?.like_num != null) b.push(`赞 ${it.like_num}`)
  else if (it?.like != null) b.push(`赞 ${it.like}`)
  if (it?.hot != null) b.push(`热度 ${it.hot}`)
  if (it?.view != null) b.push(`播放 ${it.view}`)
  if (it?.count != null) b.push(`×${it.count}`)
  if (it?.episodes != null) b.push(`${it.episodes} 集`)
  if (it?.stars_today) b.push(`今日+${it.stars_today}`)
  if (it?.platform) b.push(String(it.platform))
  if (it?.cat) b.push(String(it.cat))
  if (it?.kw) b.push(`#${it.kw}`)
  if (Array.isArray(it?.tags) && it.tags.length) b.push(it.tags.join('/'))
  if (it?.rank != null) b.push(`No.${it.rank}`)
  if (it?.position != null) b.push(`No.${it.position}`)
  if (it?.monetize) b.push(String(it.monetize))
  return b.join(' · ')
}

/* ── 日期切换 (available_dates 升序: 旧 → 新) ── */
const curIndex = computed(() => availableDates.value.indexOf(currentDate.value))
const prevDate = computed(() => (curIndex.value > 0 ? availableDates.value[curIndex.value - 1] : ''))
const nextDate = computed(() =>
  curIndex.value >= 0 && curIndex.value < availableDates.value.length - 1 ? availableDates.value[curIndex.value + 1] : '')

onMounted(load)
</script>

<style scoped>
/* ★ 单 qa-20261126-003: /hot 自己就是滚动容器
   —— 共享布局 main.content 是 overflow:hidden (所有页面共用, 不能改) → 本页自己开滚
   —— 写法照 pages/free.vue 的既有约定: height:100% + min-height:0 + overflow */
.hot-page {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
/* ★ 8 个分区两两并排; minmax(0,1fr) + 子项 min-width:0 → 长标题不会把网格撑出横向滚动条 */
.hot-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  align-items: start;
}
.hot-grid > .hot-section { min-width: 0; }
.hot-group, .hot-item, .hot-list { min-width: 0; }
.hot-link, .hot-title-plain, .hot-sub { overflow-wrap: anywhere; }
/* ★ 窄窗口回退单列 (不压扁、不出横向滚动条) */
@media (max-width: 1280px) {
  .hot-grid { grid-template-columns: minmax(0, 1fr); }
}
.hot-head { padding: 14px 16px; }
.hot-head-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.hot-title { font-size: 16px; font-weight: 600; color: var(--text-0); }
.hot-meta { font-size: 11px; margin-top: 3px; }
.hot-nav { display: flex; align-items: center; gap: 6px; }
.hot-select { width: 150px; height: 30px; padding: 4px 8px; font-size: 12px; }
.hot-state { padding: 26px 16px; text-align: center; color: var(--text-2); display: flex; align-items: center; justify-content: center; gap: 10px; }
.hot-error { color: var(--error); }
.hot-section { display: flex; flex-direction: column; gap: 8px; }
.hot-sec-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; font-size: 13px; }
.hot-sec-title { font-weight: 600; color: var(--text-0); }
.hot-group { padding: 10px 14px; }
.hot-group-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--text-2); margin-bottom: 6px; }
.hot-group-empty { font-size: 11px; padding: 4px 0; }
.hot-toggle {
  margin-top: 6px;
  align-self: flex-start;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--accent-text);
  font-size: 11.5px;
  padding: 3px 9px;
  cursor: pointer;
}
.hot-toggle:hover:not(:disabled) { border-color: var(--accent); }
.hot-toggle:disabled, .hot-toggle-plain { color: var(--text-3); cursor: default; opacity: 0.75; }
.hot-list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
.hot-item { font-size: 12.5px; line-height: 1.6; }
.hot-link { color: var(--accent-text, var(--text-0)); text-decoration: none; }
.hot-link:hover { text-decoration: underline; }
.hot-title-plain { color: var(--text-0); }
.hot-sub { font-size: 11px; margin-left: 8px; }
.hot-empty { padding: 14px; font-size: 12px; color: var(--text-3); }
</style>
