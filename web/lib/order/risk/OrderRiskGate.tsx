"use client";

/**
 * OrderRiskGate — the renderless contract that pairs `useOrderRisk` with
 * `<OrderConfirmSummary>`.
 *
 * Why a wrapper at all when the hook already produces the branded summary?
 * Because the chokepoint should be visible at call sites. A surface that
 * imports `useOrderRisk` and feeds the result to `<OrderConfirmSummary>` by
 * hand is technically equivalent to using the gate, but the gate makes the
 * contract literal: ONE component, ALL the wiring, no opportunity for the
 * next refactor to introduce a forgotten step (telemetry, pending render,
 * coverage chips later).
 *
 * Surfaces pass `input` and `portfolio`. The gate handles the rest.
 */

import type { PortfolioData } from "@/lib/types";
import { OrderConfirmSummary } from "../components/OrderConfirmSummary";
import { useOrderRisk, type OrderRiskInput, type OrderRiskState } from "./useOrderRisk";
import { useRecordOrderRiskTrace } from "./telemetry";

export interface OrderRiskGateProps {
  /**
   * Full risk input. Pass `null` when the form is not in a confirm state
   * (e.g. user is still typing); the gate then renders nothing.
   */
  input: OrderRiskInput | null;
  /**
   * Live portfolio snapshot. `undefined` = still loading → renders pending
   * skeleton. `null` = surface intentionally has no portfolio context →
   * renders "Coverage indeterminate — portfolio not in scope" skeleton.
   */
  portfolio: PortfolioData | null | undefined;
  /**
   * Surface tag used for telemetry. Required so a future bug report's
   * sessionStorage dump identifies WHICH surface produced which trace.
   * Use kebab-case literals: "chain-builder", "order-tab-single",
   * "instrument-modal", etc.
   */
  surface: string;
  /** Pass-through to `<OrderConfirmSummary>`. */
  variant?: "info" | "neutral";
  /** Custom class on the rendered summary. */
  className?: string;
  /**
   * Optional callback fired with the resolved risk state. Lets the parent
   * gate its submit button on `okToSubmit` without duplicating the hook
   * call. Equivalent to `useOrderRisk` directly but no extra render.
   */
  onState?: (state: OrderRiskState | null) => void;
}

export function OrderRiskGate({
  input,
  portfolio,
  surface,
  variant = "info",
  className,
  onState,
}: OrderRiskGateProps) {
  const state = useOrderRisk(input, portfolio);

  // Imperative callback so parents can wire submit-button enablement off
  // the resolved state without re-running the hook themselves.
  if (onState) {
    onState(state);
  }

  // Telemetry: record one trace per resolved-state observation. The hook
  // unconditionally runs (React hooks rule) — when `state` is null it
  // simply records nothing. `chainLegs` only exists on the option branch;
  // linear inputs report legCount = 1 (one instrument) and contracts =
  // the linear quantity.
  const isLinear = input?.type === "linear";
  const isOption = input != null && !isLinear;
  const legCount = isOption ? (input as { chainLegs: unknown[] }).chainLegs.length : isLinear ? 1 : 0;
  const totalContracts = isOption
    ? (input as { chainLegs: { quantity: number }[] }).chainLegs.reduce(
        (sum, l) => sum + Math.max(1, Math.trunc(l.quantity)),
        0,
      )
    : isLinear
      ? Math.max(1, Math.trunc((input as { quantity: number }).quantity))
      : 0;
  useRecordOrderRiskTrace(
    surface,
    state?.summary ?? null,
    input?.ticker ?? "",
    legCount,
    totalContracts,
    state?.coveringLegs.length ?? 0,
    0, // netPremiumAdjustment is internal; future: surface on state if needed
    state?.summary.maxLossUnbounded === true ||
      (state?.summary.undefinedRiskReason != null && state.summary.undefinedRiskReason.length > 0),
  );

  if (state == null) return null;

  return (
    <OrderConfirmSummary
      summary={state.summary}
      variant={variant}
      className={className}
    />
  );
}
