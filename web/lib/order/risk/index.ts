/**
 * Public risk module surface.
 *
 * This is the ONLY entry point that order-entry surfaces should import from.
 * Everything reachable through this barrel is portfolio-aware; the raw
 * `computeOrderRisk` / `augmentOrderLegsWithPortfolioCoverage` functions
 * live under `./internal/` and are blocked by ESLint
 * (`no-restricted-imports`) from being imported anywhere else in the app.
 */

export { useOrderRisk } from "./useOrderRisk";
export type { OrderRiskInput, OrderRiskState, ChainOrderLeg, CoveringPortfolioLeg } from "./useOrderRisk";
export { OrderRiskGate } from "./OrderRiskGate";
export type { OrderRiskGateProps } from "./OrderRiskGate";
export type { AugmentedOrderSummary, CoverageStatus, OrderPresentationSummary } from "../types";
