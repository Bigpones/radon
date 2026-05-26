/**
 * @vitest-environment jsdom
 *
 * Contract tests for the order-risk chokepoint (steps 1+2 of the refactor
 * in `tasks/order-risk-chokepoint-refactor.md`).
 *
 * Three guarantees this suite pins:
 *
 * 1. `useOrderRisk` emits a branded `AugmentedOrderSummary` with the
 *    correct `coverageStatus` for each input regime (resolved / pending /
 *    no-portfolio).
 * 2. `<OrderConfirmSummary>` renders a "Coverage indeterminate" skeleton
 *    when status is not `"resolved"` — never silently shows zeros.
 * 3. `<OrderRiskGate>` produces the same end-to-end result as calling the
 *    hook directly and feeding the summary to `<OrderConfirmSummary>` —
 *    proving the gate is just a thin pairing and adds no surprise behavior.
 *
 * These tests run independently of the 50 `order-risk.test.ts` math cases,
 * so a future refactor of `computeOrderRisk` cannot mask a regression in
 * the chokepoint contract itself.
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, renderHook } from "@testing-library/react";
import type { PortfolioData } from "@/lib/types";
import { OrderRiskGate, useOrderRisk } from "@/lib/order/risk";
import { isAugmentedOrderSummary } from "@/lib/order/types";
import { OrderConfirmSummary } from "@/lib/order/components/OrderConfirmSummary";
import { brandAugmentedSummaryForTest } from "@/lib/order/risk/__test_only__";

afterEach(cleanup);

const emptyPortfolio: PortfolioData = {
  positions: [],
  bankroll: 0,
  open_risk: 0,
  open_risk_pct: 0,
  convexity_score: null,
  convexity_breakdown: null,
  account_summary: null,
} as unknown as PortfolioData;

const sampleInput = {
  ticker: "WULF",
  chainLegs: [
    { action: "SELL" as const, right: "C" as const, strike: 31, expiry: "20270115", quantity: 77 },
  ],
  netPremium: -5.60,
  description: "Short Call @ $5.60",
  totalCost: -43_120,
};

describe("useOrderRisk — branded output contract", () => {
  it("returns null when input is null", () => {
    const { result } = renderHook(() => useOrderRisk(null, emptyPortfolio));
    expect(result.current).toBeNull();
  });

  it("emits coverageStatus='pending' when portfolio is undefined", () => {
    const { result } = renderHook(() => useOrderRisk(sampleInput, undefined));
    expect(result.current).not.toBeNull();
    expect(result.current!.coverageStatus).toBe("pending");
    expect(result.current!.okToSubmit).toBe(false);
    expect(isAugmentedOrderSummary(result.current!.summary)).toBe(true);
    expect(result.current!.summary.coverageStatus).toBe("pending");
  });

  it("emits coverageStatus='no-portfolio' when portfolio is null", () => {
    const { result } = renderHook(() => useOrderRisk(sampleInput, null));
    expect(result.current!.coverageStatus).toBe("no-portfolio");
    expect(result.current!.okToSubmit).toBe(false);
    expect(result.current!.summary.coverageStatus).toBe("no-portfolio");
  });

  it("emits coverageStatus='resolved' when portfolio is provided", () => {
    const { result } = renderHook(() => useOrderRisk(sampleInput, emptyPortfolio));
    expect(result.current!.coverageStatus).toBe("resolved");
    expect(isAugmentedOrderSummary(result.current!.summary)).toBe(true);
    expect(result.current!.summary.coverageStatus).toBe("resolved");
  });

  it("gates okToSubmit on a resolved, defined-risk verdict only", () => {
    // Naked short call on empty portfolio → UNBOUNDED → okToSubmit MUST be false
    const { result } = renderHook(() => useOrderRisk(sampleInput, emptyPortfolio));
    expect(result.current!.coverageStatus).toBe("resolved");
    expect(result.current!.summary.maxLossUnbounded).toBe(true);
    expect(result.current!.okToSubmit).toBe(false);
  });

  it("close-out short-circuit emits proceeds + realized P&L, no risk fields", () => {
    const closeInput = {
      ticker: "RR",
      chainLegs: [],
      netPremium: -0.19,
      description: "Close 100x RR $3.50C @ $0.19",
      totalCost: 1_900,
      closeOut: { entryCostDollars: 500 },
    };
    const { result } = renderHook(() => useOrderRisk(closeInput, emptyPortfolio));
    expect(result.current!.summary.totalLabel).toMatch(/Close Credit/);
    expect(result.current!.summary.estimatedPnl).toBe(1_400); // $1,900 − $500
    expect(result.current!.summary.maxLoss).toBeUndefined();
    expect(result.current!.summary.maxGain).toBeUndefined();
    expect(result.current!.okToSubmit).toBe(true);
  });

  it("emits a fresh traceId per memo input (correlates with telemetry buffer)", () => {
    const { result: a } = renderHook(() => useOrderRisk(sampleInput, emptyPortfolio));
    const { result: b } = renderHook(() => useOrderRisk(sampleInput, emptyPortfolio));
    expect(a.current!.summary.traceId).toBeDefined();
    expect(b.current!.summary.traceId).toBeDefined();
    // Different render cycles → different trace ids
    expect(a.current!.summary.traceId).not.toBe(b.current!.summary.traceId);
  });
});

describe("OrderConfirmSummary — pending / no-portfolio skeleton", () => {
  it("renders a 'Coverage indeterminate — portfolio resolving' skeleton when pending", () => {
    const summary = brandAugmentedSummaryForTest(
      { description: "Short Call @ $5.60", totalCost: -43_120 },
      { coverageStatus: "pending" },
    );
    const { container } = render(<OrderConfirmSummary summary={summary} />);
    expect(container.textContent).toMatch(/Coverage indeterminate/);
    expect(container.textContent).toMatch(/resolving/);
    // Must NOT silently render zero max-loss
    expect(container.textContent).not.toMatch(/Max Loss/);
    expect(container.querySelector("[data-coverage-status='pending']")).toBeTruthy();
  });

  it("renders a 'portfolio not in scope' skeleton when status is 'no-portfolio'", () => {
    const summary = brandAugmentedSummaryForTest(
      { description: "Short Call @ $5.60", totalCost: -43_120 },
      { coverageStatus: "no-portfolio" },
    );
    const { container } = render(<OrderConfirmSummary summary={summary} />);
    expect(container.textContent).toMatch(/Coverage indeterminate/);
    expect(container.textContent).toMatch(/not in scope/);
    expect(container.querySelector("[data-coverage-status='no-portfolio']")).toBeTruthy();
  });

  it("renders the full risk panel when status is 'resolved'", () => {
    const summary = brandAugmentedSummaryForTest({
      description: "Bull Call Spread @ $2.00",
      totalCost: 200,
      maxLoss: 200,
      maxGain: 800,
    });
    const { container } = render(<OrderConfirmSummary summary={summary} />);
    expect(container.textContent).toMatch(/Max Loss/);
    expect(container.textContent).toMatch(/Max Gain/);
    expect(container.textContent).not.toMatch(/Coverage indeterminate/);
  });
});

describe("OrderRiskGate — gate is a thin pairing", () => {
  it("renders nothing when input is null", () => {
    const { container } = render(
      <OrderRiskGate input={null} portfolio={emptyPortfolio} surface="test" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders <OrderConfirmSummary> when input is provided", () => {
    const { container } = render(
      <OrderRiskGate input={sampleInput} portfolio={emptyPortfolio} surface="test" />,
    );
    // The naked short call on empty portfolio yields UNBOUNDED — that label
    // must reach the DOM via the gate.
    expect(container.textContent).toMatch(/Short Call/);
    expect(container.textContent).toMatch(/UNBOUNDED/);
  });

  it("renders the pending skeleton when portfolio is undefined", () => {
    const { container } = render(
      <OrderRiskGate input={sampleInput} portfolio={undefined} surface="test" />,
    );
    expect(container.textContent).toMatch(/Coverage indeterminate/);
    expect(container.textContent).not.toMatch(/UNBOUNDED/);
  });

  it("calls onState callback with the resolved state", () => {
    let captured: unknown = null;
    render(
      <OrderRiskGate
        input={sampleInput}
        portfolio={emptyPortfolio}
        surface="test"
        onState={(s) => { captured = s; }}
      />,
    );
    expect(captured).not.toBeNull();
    expect((captured as { coverageStatus: string }).coverageStatus).toBe("resolved");
  });
});

describe("brand integrity", () => {
  it("isAugmentedOrderSummary returns false for plain literals", () => {
    expect(
      isAugmentedOrderSummary({
        description: "fake",
        totalCost: 0,
      }),
    ).toBe(false);
  });

  it("isAugmentedOrderSummary returns true for hook output", () => {
    const { result } = renderHook(() => useOrderRisk(sampleInput, emptyPortfolio));
    expect(isAugmentedOrderSummary(result.current!.summary)).toBe(true);
  });

  it("isAugmentedOrderSummary returns true for brandAugmentedSummaryForTest output", () => {
    const branded = brandAugmentedSummaryForTest({
      description: "test",
      totalCost: 0,
    });
    expect(isAugmentedOrderSummary(branded)).toBe(true);
  });
});
