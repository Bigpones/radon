import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  ...nextVitals,
  {
    rules: {
      // React Compiler–oriented rules from eslint-config-next: enable incrementally; do not block `npm run lint`.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/immutability": "off",
      "react-hooks/preserve-manual-memoization": "off",

      // Order-risk chokepoint enforcement. The math primitives
      // (`computeOrderRisk`, `augmentOrderLegsWithPortfolioCoverage`) and
      // the brand symbol must NOT be imported from production code — every
      // order surface flows through `useOrderRisk` / `<OrderRiskGate>` in
      // `@/lib/order/risk`. Test files are exempt via the global
      // `tests/**` + `e2e/**` ignore patterns above.
      //
      // Why: three production bugs in eight days (AAOI 2026-05-19, WULF
      // 2026-05-26 morning, RR 2026-05-26 afternoon) all shipped because
      // a surface hand-built risk math and missed portfolio coverage.
      // The chokepoint pattern (brand + lint + dev-mode runtime assert)
      // makes that impossible. See `tasks/order-risk-chokepoint-refactor.md`.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/lib/order/risk/internal/*",
                "**/lib/order/risk/internal/*",
                "@/lib/order/risk/__test_only__",
                "**/lib/order/risk/__test_only__",
                "@/lib/orderRisk",
                "**/lib/orderRisk",
              ],
              message:
                "Use `useOrderRisk` / `<OrderRiskGate>` from `@/lib/order/risk` — the raw math is module-private so every surface goes through the portfolio-aware augmentation pipeline. See web/CLAUDE.md → Order-risk chokepoint.",
            },
          ],
        },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "playwright-report/**",
    "test-results/**",
    "tests/**",
    "e2e/**",
  ]),
]);
