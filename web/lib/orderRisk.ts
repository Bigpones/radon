/**
 * BACKWARDS-COMPATIBLE TEST SHIM.
 *
 * Pre-refactor, `web/lib/orderRisk.ts` was the home of `computeOrderRisk`
 * and `augmentOrderLegsWithPortfolioCoverage`. Production callers are now
 * routed through `useOrderRisk` / `<OrderRiskGate>` in `@/lib/order/risk`,
 * and direct imports of the math functions are blocked by ESLint outside
 * `lib/order/risk/internal/`.
 *
 * This shim re-exports the internals so the existing 50-case test file
 * (`web/tests/order-risk.test.ts`) keeps working without modification.
 * The ESLint rule is configured to allow imports from this file ONLY from
 * test files (`tests/**`, `**\/*.test.ts`); production code that imports
 * `@/lib/orderRisk` directly is flagged.
 *
 * Do NOT import this module from production code. If you need risk math
 * in a new surface, render `<OrderRiskGate>` instead.
 */

export {
  computeOrderRisk,
  augmentOrderLegsWithPortfolioCoverage,
  type OrderRisk,
  type OrderRiskLeg,
  type ChainOrderLeg,
  type CoveringPortfolioLeg,
  type AugmentedOrderLegs,
  type LegRight,
  type LegAction,
} from "./order/risk/internal/computeOrderRisk";
