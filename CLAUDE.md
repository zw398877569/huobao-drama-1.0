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
