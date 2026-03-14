# Web Bundle Size — Ideas Backlog

## Applied (1124KB → 921KB, −18.1%)
- Replace react-markdown + remark-gfm with lightweight inline renderer (−137KB raw)
- d3 selective imports instead of `import * as d3` (−16KB raw)
- Remove dead dependencies: @fontsource/ibm-plex-mono, @vercel/analytics, ib
- SWC removeConsole in production (−1KB)
- Replace d3-time-format with Intl.DateTimeFormat
- Rewrite CriHistoryChart from imperative d3 DOM to declarative React SVG (−13KB, removes d3-selection + d3-axis)
- Replace d3-array with 1.5KB arrayUtils.ts (extent, mean, bisectLeft)
- Replace d3-shape with 2.6KB svgPath.ts (monotone cubic Hermite line generator) (−5KB)
- Replace d3-scale with 3.9KB scales.ts (scaleLinear + scaleTime with ticks) (−31KB, removes d3-format + d3-interpolate + d3-time + d3-time-format + d3-color)
- Move @sinclair/typebox to devDependencies

## Explored and rejected
- Dynamic import ChatPanel/MetricCards/WorkspaceSections: +13KB overhead from chunk wrappers
- Dynamic import PriceChart only: +4KB overhead
- Dynamic import all ticker-detail tabs: +11KB overhead
- optimizePackageImports / modularizeImports: Turbopack already handles tree-shaking
- reactStrictMode: false: no effect on production bundle
- Remove dead packages: no bundle change (Turbopack tracks imports, not package.json)

## Remaining ideas (diminishing returns territory)
- CSS audit: ~134 potentially unused selectors in globals.css (risky — many dynamic class names)
- Deduplicate className string constants (minimal impact — gzip handles repetition)
- Move WorkspaceSections into per-route components (requires architecture change)
- Check if liveline (PriceChart) canvas code can be reduced via tree-shaking config
- Remove dead lib modules: store.ts, useIBStatus.ts (already excluded by Turbopack)
- Reduce sectionTooltips.ts verbose text (changes content, not a pure optimization)
