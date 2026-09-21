# CLAUDE.md

## Project Overview

Huobao Drama — AI-powered drama/video production tool. Full TypeScript stack.

## Structure

```
backend/   — Hono + Drizzle ORM + Mastra (AI agents) + better-sqlite3
frontend/  — Vue 3 + TypeScript + Vite (pure CSS, no UI framework)
configs/   — config.yaml
data/      — SQLite database + static files
skills/    — Agent SKILL.md definitions
```

## Commands

### Backend (`backend/`)
- `npm run dev` — Start dev server with tsx watch (port 5679)
- `npm start` — Start production server
- `npm run typecheck` — TypeScript type checking

### Frontend (`frontend/`)
- `npm run dev` — Vite dev server (port 3013, proxies /api to 5679)
- `npm run build` — Production build
- `npm run generate` — Nuxt static-site generation (used by Docker `frontend-build` stage; run this locally to catch SFC / template / type errors before committing)

## Workflow

When the user asks to commit / push code, follow this order:

1. Make the edits in the working tree.
2. **Verify locally before staging anything:**
   - For backend changes: `cd backend && npm run typecheck`.
   - For frontend changes: `cd frontend && npm run generate` — this is
     the exact command Docker runs in the `frontend-build` stage, so a
     green run locally means the container build will also pass. If
     `tsc --noEmit` and superficial regex checks pass but this fails,
     fix the failure before continuing (a 2026-07-28 incident shipped
     a `<script setup>` block with TypeScript annotations but no
     `lang="ts"`, which only surfaced during the Nuxt production
     build).
   - For cross-stack changes: run both.
3. `git add` only the files the user asked to commit; do not lump in
   unrelated package-lock churn or untracked scratch files.
4. Commit with a focused message and push to `origin/master`.

Never commit code that hasn't been verified to build. If a verification
command cannot run (sandbox limits, missing network, etc.), say so
explicitly rather than skipping the step.

## 线程职责边界 (2026-09-21 新增硬约束)

每个 work thread session 改 / 提交 / push 代码前必做 — 不能跳过:

### 1. 改代码前 — `git status` 看清楚当前改动范围

- 改的文件必须**全部**来自自己的 handoff 任务范围 (`msg-<id>.json` payload.scope.modified_files / new_files)
- 任务范围外的文件**不要碰** (即使只是顺手修个 typo)
- 不属于自己派单的文件改动 → revert + 重新审视任务

### 2. commit 前 — `git diff --stat` 确认改动范围

- staged 改动 = 自己派单要求改的文件
- 改动超任务范围 → reset 那些文件 + 重新审视任务

### 3. push 前 — `git log --format='%h %ae %s' origin/master..HEAD` review

- 本地独有 commit 必须**都是当前 agent 处理的** (任务来源 = 当前 handoff)
- 如果看到不认识的 commit:
  - ❌ 不要 `git reset` (会动到别人的本地仓库, 即使 reset 看起来只影响自己)
  - ❌ 不要 `git rebase` (会改写 history)
  - ❌ 不要 `git cherry-pick` 别人
  - ✅ **停下来告诉用户**: "本地有 commit <hash> 来自其他线程/agent, 我没动, 请你决定怎么处理"
  - ✅ 等用户**明确指令**后再操作

### 4. **不允许 force push 到 master / main**

- pre-push hook 会自动拦截 force push
- 真要 force push 必须 `git push --no-verify` 显式绕过 (告诉用户原因)
- 工作树有未提交改动时, push 也会被拦截 (防丢改动)

### 5. **不基于 author 判断**

- 多个 codex 线程共用同一 author (`codex <codex@local>`), author 限制不可靠
- 真正的判断标准是「这个 commit 是不是 agent 当前任务处理的」, **只能 agent 自己判断**
- hook 不做 author 检查 (防止误拦 CI bot commit 或同 author 不同线程的 commit)

### 安装 hooks (一次性)

```bash
bash scripts/install-hooks.sh
# 安装 .githooks/pre-commit + .githooks/pre-push 到 .git/hooks/
# 后续 commit / push 自动触发检查
```

### 历史教训 (2026-09-21 incident)

复盘 2026-09-21 一次事故: agent 看到本地有其他线程的 commit (cron 监控面板 `0a516f2`), 没停下来问用户, 直接 `git reset --hard` 把别人 commit 在本地删除, 然后 `git push` 把 reset+自己的 commit 一起推到 origin.

影响:
- origin history 多了一个本来不该 agent 推的 commit (Mac 提交的 `0a516f2`)
- Mac 的本地仓库 `0a516f2` 还在 (reset 只影响 agent 自己的本地仓库), 但 origin 上出现了

修复: agent 撤回了 `0a516f2` (reset --hard + force push, auto-review 拦住后由用户显式确认)

**这个事故不应该再发生**: 看到不认识的 commit → 立刻停下来问用户, 不 reset / rebase / cherry-pick.

## Architecture

### Backend
- **HTTP**: Hono framework with CORS, logger middleware
- **Database**: Drizzle ORM + better-sqlite3, WAL mode, schema in `src/db/schema.ts`
- **AI Agents**: Mastra framework with AI SDK (OpenAI compatible providers)
- **Agent Types**: script_rewriter, extractor, storyboard_breaker
- **SSE Streaming**: Hono streamSSE for agent chat responses
- **File Storage**: Local filesystem under `data/static/`

### Frontend
- **Vue 3** + TypeScript + Vite
- **Routing**: Vue Router (4 routes: list, detail, workbench, settings)
- **State**: Single composable `useWorkbench.ts` for workbench page
- **API**: Unified fetch client in `src/api/index.ts` with SSE async generator
- **Styling**: Pure CSS with CSS variables (dark theme)

## Database
SQLite at `data/drama_generator.db`. Schema matches existing GORM-created tables.
Auto-WAL mode. No migrations needed — reads existing DB directly.

## Key Config
- `configs/config.yaml` — AI provider defaults
- AI service configs stored in DB (`ai_service_configs` table)
- Agent configs stored in DB (`agent_configs` table)
