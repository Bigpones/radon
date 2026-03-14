# Autoresearch: Web Dashboard Bundle Size Optimization

## Objective
Minimize client-side JavaScript bundle size for the Radon Terminal web dashboard (Next.js 16 / Turbopack / React 19). The dashboard is at `web/` and serves a real-time trading terminal with charts, options chains, order management, and regime analysis.

## Metrics
- **Primary**: `bundle_kb` (KB, lower is better) — total client JS in `.next/static/`
- **Secondary**: `build_s` — build time in seconds, `css_kb` — CSS size, `chunk_count` — number of JS chunks

## Baseline
- **1,125 KB** total client JS (16 chunks)
- **80 KB** CSS
- **~7.6s** build time
- Largest chunks: 540KB (markdown ecosystem), 220KB (Next.js internals), 124KB (React), 112KB (app code)

## How to Run
`./autoresearch.sh` — cleans `.next/`, builds, measures JS/CSS sizes, outputs `METRIC` lines.

## Files in Scope
- `web/components/*.tsx` — UI components (23K lines total across 42 files)
- `web/components/ticker-detail/*.tsx` — Ticker detail page tabs
- `web/lib/*.ts` — Utility libraries, hooks, types
- `web/app/**/*.tsx` — Page components and API routes
- `web/next.config.ts` — Next.js/Turbopack configuration
- `web/package.json` — Dependencies
- `web/tailwind.config.ts` — Tailwind CSS config (if it exists)

## Off Limits
- `web/tests/` — Test files must not be modified
- `web/e2e/` — E2E tests must not be modified
- `web/public/` — Static assets
- `scripts/` — Python backend scripts
- `lib/tools/` — Pi tool definitions
- Do NOT change the visual output or behavior of any component
- Do NOT remove features

## Constraints
- All 95 vitest tests must pass (9 are pre-existing failures — those 9 may remain failing but no NEW failures)
- Build must succeed (`npm run build` exit 0)
- No new npm dependencies (removing deps is fine)
- Functionality must be preserved — same visual output, same interactivity

## Key Findings (Pre-Session Analysis)

### Chunk Breakdown
| Chunk | Size (KB) | Contents |
|-------|-----------|----------|
| a893bf... | 540 | **Markdown ecosystem** (micromark, mdast, hast, unified, remark-gfm, react-markdown) |
| 5a795e... | 220 | Next.js framework internals |
| f201dd... | 124 | React 19 runtime |
| a6dad9... | 112 | Application code + components |
| Others | 129 | Small chunks (Turbopack runtime, manifests, etc.) |

### High-Impact Targets
1. **react-markdown + remark-gfm (540KB)** — Used in ONE component (`ChatPanel.tsx → MarkdownRenderer.tsx`). The entire unified/micromark/mdast/hast ecosystem is bundled for rendering chat messages. Replace with lightweight alternative or lazy-load.
2. **d3 (full import)** — `import * as d3` in 2 components (`CriHistoryChart.tsx`, `RegimeRelationshipView.tsx`). Only uses ~8 functions from d3-selection, d3-scale, d3-shape, d3-time-format, d3-array. Selective imports could save significant weight.
3. **lucide-react (43MB node_modules)** — 26 icons used. Tree-shaking should handle this, but verify.

### Lower-Impact Targets
- `@fontsource/ibm-plex-mono` — font file bundling
- `@sinclair/typebox` — schema validation library
- Component code splitting — large components that could be lazy-loaded

## What's Been Tried
(Updated as experiments run)

