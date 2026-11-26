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
            <li v-for="(it, i) in g.items" :key="i" class="hot-item">
              <a v-if="linkOf(it)" class="hot-link" :href="linkOf(it)" target="_blank" rel="noopener">{{ titleOf(it) }}</a>
              <span v-else class="hot-title-plain">{{ titleOf(it) }}</span>
              <span v-if="subOf(it)" class="dim hot-sub">{{ subOf(it) }}</span>
            </li>
          </ol>
          <div v-else class="dim hot-group-empty">（无条目）</div>
        </div>
      </section>
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
.hot-page { padding: 16px; display: flex; flex-direction: column; gap: 14px; }
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
.hot-list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
.hot-item { font-size: 12.5px; line-height: 1.6; }
.hot-link { color: var(--accent-text, var(--text-0)); text-decoration: none; }
.hot-link:hover { text-decoration: underline; }
.hot-title-plain { color: var(--text-0); }
.hot-sub { font-size: 11px; margin-left: 8px; }
.hot-empty { padding: 14px; font-size: 12px; color: var(--text-3); }
</style>
