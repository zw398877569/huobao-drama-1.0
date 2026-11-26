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
      <!-- ★ 单 243 T2: 统计概览 (页头正下方, 8 个分区列表的上方) —— 两个图并排 -->
      <section class="hot-overview">
        <div class="card hot-chart">
          <div class="hot-chart-head">
            <span class="hot-chart-title">题材分布 Top 12</span>
            <span class="dim mono">题材 {{ genreTop.length }} 个</span>
          </div>
          <div v-if="!genreTop.length" class="dim hot-chart-empty">暂无题材数据</div>
          <div v-for="t in genreTop" :key="`genre-${t.name}`" class="hot-bar">
            <span class="hot-bar-name" :title="t.name">{{ t.name }}</span>
            <span class="hot-bar-track"><span class="hot-bar-fill" :style="{ width: `${t.pct}%` }"></span></span>
            <span class="hot-bar-val mono">{{ t.value }}</span>
          </div>
        </div>
        <div class="card hot-chart">
          <div class="hot-chart-head">
            <span class="hot-chart-title">各平台数据量对比</span>
            <span class="dim mono">裁剪后条数 · 各组全部展开后可见</span>
          </div>
          <div v-if="!platformRows.length" class="dim hot-chart-empty">暂无平台数据</div>
          <div v-for="p in platformRows" :key="`platform-${p.name}`" class="hot-bar">
            <span class="hot-bar-name" :title="p.name">{{ p.name }}</span>
            <span class="hot-bar-track"><span class="hot-bar-fill" :style="{ width: `${p.pct}%` }"></span></span>
            <span class="hot-bar-val mono">{{ p.value }}</span>
          </div>
        </div>
      </section>

      <!-- ★ 单 243 T3: masonry (CSS 多列) —— 8 个分区自然流入两列, 右边不留大片空白
           ★ 用户已知并接受: 多列是先竖后横填充 (不是从左到右再下一行) -->
      <div class="hot-sections">
        <section v-for="s in sections" :key="s.key" class="hot-section">
          <div class="card hot-sec-head">
            <span class="hot-sec-title">{{ s.label }}</span>
            <span class="dim">
              榜单 {{ countItems(s) }} 条<span v-if="sourceCount(s)"> · 数据源 {{ sourceCount(s) }}</span>
            </span>
          </div>

          <div v-if="!groupsOf(s).length" class="card hot-empty">该分区暂无数据</div>

          <div v-for="g in groupsOf(s)" :key="g.label" class="card hot-group">
            <!-- ★ 单 244 T1: 只有计数、没有条目列表的组 (例: 关键词 AI动画 —— 17 条)
                 → 只渲染【一行摘要】: 不渲染条目区 / 不渲染『（无条目）』文字 / 不渲染『无条目』徽章
                 (这些组的值在接口里本来就是数字计数 xhs_by_keyword = {"AI动画":17,...}, 不是条目列表) -->
            <div v-if="!g.items.length && g.note" class="hot-group-summary">{{ g.label }} —— {{ g.note }}</div>
            <template v-else>
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
              <!-- ★ 单 244 T1: 真的 0 条目 (没有计数) → 仍显示『（无条目）』, 别把正常空状态一起改没了 -->
              <div v-else class="dim hot-group-empty">（无条目）</div>
              <!-- 每个组一个按钮, 各组状态互相独立 (本单不做全局总开关 / 不做状态持久化);
                   ★ 只有计数的组不渲染按钮 (没东西可展开), 真空组保留置灰徽章 -->
              <button
                v-if="g.items.length || !g.note"
                class="hot-toggle"
                :class="{ 'hot-toggle-plain': g.items.length <= COLLAPSE_LIMIT }"
                :disabled="g.items.length <= COLLAPSE_LIMIT"
                @click="toggleGroup(s, g)"
              >
                {{ toggleLabel(s, g) }}
              </button>
            </template>
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
// ★ 单 243 T2: 统计概览 (题材分布 Top 12 + 各平台数据量对比) —— 纯函数在 utils/hot-overview.ts
import { buildGenreTop, buildPlatformRows } from '~/utils/hot-overview'

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

/* ── T2: 统计概览数据 (题材 Top 12 / 各平台数据量) ── */
const genreTop = computed(() => buildGenreTop(raw.value))
const platformRows = computed(() => buildPlatformRows(raw.value))

/* ── 分区工具 ── */
function groupsOf(s: Section): Group[] {
  const d = raw.value || {}
  let gs: Group[] = []
  try { gs = s.groups(d) || [] } catch { gs = [] }
  // ★ 单 244 T1: 0 条目的组【也要渲染】(显示『（无条目）』) —— 以前这个过滤把它们挡掉了,
  //   页面上根本看不到真空组 (B站 分区1 / GitHub 英文AIGC+两个总榜 / 跨平台 跨平台内容),
  //   AC3 的『正常空状态别被改没了』就没法验证了
  return gs.filter((g) => g && Array.isArray(g.items))
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
/* ★ 单 243 T3: 8 个分区走 CSS 多列 (masonry) —— 两列高度自动均衡, 右边不留大片空白
   ★ break-inside: avoid → 一个分区不会被切成两半
   ★ 用户已知并接受: 多列是先竖后横填充 (先灌满左列再灌右列) */
.hot-sections {
  columns: 2;
  column-gap: 14px;
}
/* ★ 单 243 T2: 统计概览 (两个图并排) —— CSS 横向条形图, 没用图表库 */
.hot-overview {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  align-items: start;
}
.hot-chart { padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.hot-chart-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 13px; }
.hot-chart-title { font-weight: 600; color: var(--text-0); }
.hot-chart-empty { font-size: 12px; padding: 6px 0; }
.hot-bar { display: grid; grid-template-columns: 84px minmax(0, 1fr) 40px; align-items: center; gap: 8px; font-size: 12px; }
.hot-bar-name { color: var(--text-1, var(--text-0)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hot-bar-track { height: 10px; background: var(--bg-3); border-radius: 2px; overflow: hidden; }
.hot-bar-fill { display: block; height: 100%; background: var(--accent); border-radius: 2px; }
.hot-bar-val { text-align: right; color: var(--text-2); }
@media (max-width: 1280px) {
  .hot-overview { grid-template-columns: minmax(0, 1fr); }
}
.hot-sections > .hot-section {
  break-inside: avoid;
  -webkit-column-break-inside: avoid;
  page-break-inside: avoid;
  margin-bottom: 14px;
  min-width: 0;
}
.hot-group, .hot-item, .hot-list { min-width: 0; }
.hot-link, .hot-title-plain, .hot-sub { overflow-wrap: anywhere; }
/* ★ 窄窗口回退单列 (不压扁、不出横向滚动条) */
@media (max-width: 1280px) {
  .hot-sections { columns: 1; }
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
/* ★ 单 244 T1: 只有计数的组 → 一行摘要 (例: 关键词 AI动画 —— 17 条) */
.hot-group-summary { font-size: 12px; color: var(--text-1, var(--text-0)); }
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
