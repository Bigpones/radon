"use client";

/**
 * useOrderRisk — the ONLY public way to produce an `AugmentedOrderSummary`.
 *
 * Every order-entry surface in the app routes through this hook (typically
 * via `<OrderRiskGate>`, which pairs the hook with `<OrderConfirmSummary>`).
 * Direct use of `computeOrderRisk` / `augmentOrderLegsWithPortfolioCoverage`
 * is ESLint-banned outside `lib/order/risk/internal/` precisely so that
 * portfolio-aware augmentation is not bypassable by a new surface.
 *
 * Inputs in: ticker, chain legs, net premium, descriptive labels, and the
 * portfolio snapshot. Output: `OrderRiskState` carrying a branded
 * `AugmentedOrderSummary` ready to hand to `<OrderConfirmSummary>`.
 *
 * Coverage status semantics:
 *   - `resolved`     — portfolio was provided and augmentation ran. Risk
 *                      numbers reflect the resulting portfolio + order
 *                      structure.
 *   - `pending`      — `portfolio === undefined`. Likely the parent has not
 *                      finished fetching. Render a skeleton + disable submit.
 *   - `no-portfolio` — `portfolio === null` was passed explicitly. The
 *                      surface intentionally has no portfolio context (or
 *                      forgot to thread it). Same UI treatment as pending.
 *
 * The hook does NOT call `usePortfolio()` directly because there is no
 * single PortfolioContext yet (a follow-up step). Until that lands, every
 * caller passes `portfolio` explicitly — but the brand + lint rule still
 * prevent the bug class because a surface that forgets to pass portfolio
 * gets a "Coverage indeterminate" skeleton instead of a wrong dollar number.
 */

import { useMemo } from "react";
import type { PortfolioData } from "@/lib/types";
import {
  type AugmentedOrderSummary,
  type CoverageStatus,
  type OrderPresentationSummary,
  ORDER_RISK_BRAND,
} from "../types";
import {
  augmentOrderLegsWithPortfolioCoverage,
  computeOrderRisk,
  type ChainOrderLeg,
  type CoveringPortfolioLeg,
} from "./internal/computeOrderRisk";

export type { ChainOrderLeg, CoveringPortfolioLeg };

export interface OrderRiskInput {
  /** Underlying symbol. Drives portfolio filtering. */
  ticker: string;
  /**
   * Chain order legs in their raw user-entered form. Single-leg orders pass
   * `[{...}]`. Multi-leg combos pass each leg. Quantities are total
   * contracts; the augmenter normalises to per-combo ratios internally.
   */
  chainLegs: ChainOrderLeg[];
  /**
   * Per-share, signed net premium of the order: positive for net debit,
   * negative for net credit. Augmentation may add `netPremiumAdjustment`
   * (e.g. for stock-backed covered calls); the caller does NOT do this
   * — `useOrderRisk` folds it in.
   */
  netPremium: number;
  /** Human-readable order description, surfaced verbatim in the summary. */
  description: string;
  /**
   * Order's notional cash flow as displayed to the operator. Sign matches
   * the chain's user input (positive = debit; negative = credit). This is
   * the operator-visible "Total" field — it stays unmodified even when
   * `netPremiumAdjustment` non-zero (the adjustment affects risk math
   * only, not the displayed cash flow).
   */
  totalCost: number | null;
  /** Override "Total:" label (e.g. "Proceeds:", "Close Credit:"). */
  totalLabel?: string;
  /**
   * Close-out short-circuit. When set, the augmentation pipeline is
   * bypassed: max-loss/max-gain are zeroed (the SELL is a close, not a new
   * exposure) and `estimatedPnl` is computed from order proceeds minus
   * sunk basis. Used by close paths in OrderTab and InstrumentDetailModal.
   */
  closeOut?: {
    entryCostDollars: number;
    estimatedPnlLabel?: string;
  } | null;
  /**
   * Optional breakeven price to surface in the summary (e.g. for long
   * options). Not computed by the risk model.
   */
  breakeven?: number | null;
}

export interface OrderRiskState {
  /** Ready to pass to `<OrderConfirmSummary>`. Always branded. */
  summary: AugmentedOrderSummary;
  /** Convenience accessor — same as `summary.coverageStatus`. */
  coverageStatus: CoverageStatus;
  /**
   * True iff coverage is fully resolved AND the underlying risk model
   * returned a finite, defined-risk verdict (no UNBOUNDED, no undefined
   * risk reason). Surfaces use this to gate the submit button.
   */
  okToSubmit: boolean;
  /** Coverage entries injected, exposed for chip rendering. */
  coveringLegs: CoveringPortfolioLeg[];
}

function makeTraceId(): string {
  // crypto.randomUUID() is widely supported (Node 19+, all evergreen
  // browsers). Fallback for very old SSR contexts.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}

function brand(
  summary: OrderPresentationSummary,
  coverageStatus: CoverageStatus,
  traceId: string,
): AugmentedOrderSummary {
  return {
    ...summary,
    [ORDER_RISK_BRAND]: "augmented",
    coverageStatus,
    traceId,
  } as AugmentedOrderSummary;
}

/**
 * Build the augmented summary from raw inputs + portfolio.
 *
 * `portfolio === undefined` → pending state.
 * `portfolio === null`      → no-portfolio state (still augmentation-aware
 *                             but with no coverage available).
 * `portfolio` populated     → full augmentation + risk math.
 */
export function useOrderRisk(
  input: OrderRiskInput | null,
  portfolio: PortfolioData | null | undefined,
): OrderRiskState | null {
  return useMemo(() => {
    if (input == null) return null;

    const traceId = makeTraceId();
    const baseSummary: OrderPresentationSummary = {
      description: input.description,
      totalCost: input.totalCost,
      totalLabel: input.totalLabel,
      breakeven: input.breakeven ?? null,
    };

    // Pending: portfolio not yet provided. Surface as skeleton; no risk math.
    if (portfolio === undefined) {
      return {
        summary: brand(baseSummary, "pending", traceId),
        coverageStatus: "pending" as const,
        okToSubmit: false,
        coveringLegs: [],
      };
    }

    const coverageStatus: CoverageStatus =
      portfolio === null ? "no-portfolio" : "resolved";

    // Close-out: short-circuit risk math; surface proceeds + realized P&L.
    if (input.closeOut != null) {
      const proceeds = input.totalCost ?? 0;
      const pnl = proceeds - input.closeOut.entryCostDollars;
      const closeSummary: OrderPresentationSummary = {
        ...baseSummary,
        // Close cash flow is reported as proceeds; max-loss/max-gain are
        // structurally zero by construction (a close adds no new exposure).
        totalCost: Math.abs(proceeds),
        totalLabel: input.totalLabel ?? (proceeds >= 0 ? "Close Credit:" : "Close Debit:"),
        estimatedPnl: pnl,
        estimatedPnlLabel: input.closeOut.estimatedPnlLabel ?? "Est. Realized P&L:",
      };
      return {
        summary: brand(closeSummary, coverageStatus, traceId),
        coverageStatus,
        okToSubmit: true,
        coveringLegs: [],
      };
    }

    // Augment chain legs with portfolio coverage. When portfolio is null
    // (no-portfolio), augmentation still runs the quantity normalisation
    // step and returns the chain legs as per-combo ratios — the qty²
    // regression guard from the prior fix stays intact.
    const augmented = augmentOrderLegsWithPortfolioCoverage(
      input.chainLegs,
      input.ticker,
      portfolio,
    );

    const adjustedNetPremium = input.netPremium + augmented.netPremiumAdjustment;
    const risk = computeOrderRisk(
      augmented.riskLegs,
      adjustedNetPremium,
      augmented.comboQuantity,
    );

    const resolved: OrderPresentationSummary = {
      ...baseSummary,
      maxGain: risk.maxGain,
      maxLoss: risk.maxLoss,
      maxLossUnbounded: risk.maxLossUnbounded,
      maxGainUnbounded: risk.maxGainUnbounded,
      undefinedRiskReason: risk.undefinedRiskReason,
    };

    const okToSubmit =
      coverageStatus === "resolved" &&
      !risk.maxLossUnbounded &&
      !risk.hasUndefinedRisk;

    return {
      summary: brand(resolved, coverageStatus, traceId),
      coverageStatus,
      okToSubmit,
      coveringLegs: augmented.coveringLegs,
    };
  }, [input, portfolio]);
}
