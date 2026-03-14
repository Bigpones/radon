# Web Bundle Size — Ideas Backlog

## Applied
- Replace react-markdown + remark-gfm with lightweight inline renderer (−137KB)
- d3 selective imports instead of `import * as d3` (−16KB)
- Remove dead dependencies: @fontsource/ibm-plex-mono, @vercel/analytics, ib (0KB but cleaner)
- SWC removeConsole in production (−1KB)

## Explored and rejected
- Dynamic import ChatPanel/MetricCards/WorkspaceSections: +13KB overhead from code splitting wrapper
- optimizePackageImports for lucide-react/d3-*: Turbopack already handles tree-shaking
- modularizeImports for lucide-react: same — Turbopack already optimal
- reactStrictMode: false: no effect on production bundle
- Remove @fontsource/ibm-plex-mono, @vercel/analytics, ib packages: no bundle change (Turbopack tracks imports)

## Remaining ideas
- Replace d3-selection (DOM manipulation) with pure React SVG in charts — eliminates d3-selection, d3-axis
- CSS audit: ~134 potentially unused selectors in globals.css (risky — dynamic class names)
- Replace CriHistoryChart with Canvas API (no d3 needed, but major rewrite)
- Move WorkspaceSections into per-route components with route-level code splitting
- Check if server components can absorb more of the data processing (currently 51 "use client" components)
- Replace d3-time-format with Intl.DateTimeFormat (built-in, no import needed)
- Investigate if chart rendering can use a lighter library than d3 (e.g., uPlot at ~45KB vs d3 at ~100KB+)
