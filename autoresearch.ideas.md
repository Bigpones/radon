# Web Bundle Size — Ideas Backlog

## Applied (1124KB → 920KB, −18.2% raw / 281KB → 264KB gzip, −6.0%)
- Replace react-markdown + remark-gfm with lightweight inline renderer (−137KB raw)
- d3 selective imports instead of `import * as d3` (−16KB raw)
- Remove dead dependencies: @fontsource/ibm-plex-mono, @vercel/analytics, ib
- SWC removeConsole in production (−1KB)
- Replace d3-time-format with Intl.DateTimeFormat
- Rewrite CriHistoryChart from imperative d3 DOM to declarative React SVG (−13KB, removes d3-selection + d3-axis)
- Replace d3-array with 1.5KB arrayUtils.ts (extent, mean, bisectLeft)
- Replace d3-shape with 2.6KB svgPath.ts (monotone cubic Hermite line generator) (−5KB)
- Replace d3-scale with 3.9KB scales.ts (scaleLinear + scaleTime with ticks) (−31KB, removes d3-format + d3-interpolate + d3-time + d3-time-format + d3-color)
- Move @sinclair/typebox to devDependencies, ws to devDependencies
- Remove dead CSS rules: 43 unused selectors from old chat, connection banner, regime-cta, toast, strength, fills systems (−3KB CSS)
- Remove dead code: store.ts (zustand dep), useIBStatus.ts (no bundle change but clean)

## Explored and rejected (with reasons)
- Dynamic import ChatPanel/MetricCards/WorkspaceSections: +13KB overhead from chunk wrappers
- Dynamic import PriceChart only: +4KB overhead
- Dynamic import all ticker-detail tabs: +11KB overhead
- optimizePackageImports / modularizeImports: Turbopack already handles tree-shaking
- reactStrictMode: false: no effect on production bundle
- Remove dead packages: no bundle change (Turbopack tracks imports, not package.json)
- .browserslistrc targeting modern browsers: polyfill chunk unchanged (Turbopack ignores it), app chunk grew 6KB
- experimental.optimizeCss: no effect (Turbopack already minifies)
- Replace lucide-react with inline SVG components: +6KB — lucide's shared factory pattern minifies better
- Remove "use client" from pure-render components: they're all imported by client parents, no savings

## Remaining ideas (truly diminishing returns — sub-1KB each)
- Convert remaining 2 unused CSS custom properties (--accent-bg, --accent-text) to inline values
- Deduplicate sort header component patterns in WorkspaceSections (gzip already handles this)
- Remove kit/ components if design kit page is no longer needed (saves a few KB but removes a feature)
