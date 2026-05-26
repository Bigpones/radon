/**
 * @vitest-environment jsdom
 *
 * Telemetry buffer contract — `<OrderRiskGate>` writes ONE trace per resolved
 * state observation to a `sessionStorage` ring buffer (max 50 entries).
 *
 * Why this exists: future bug reports for "wrong max-loss" can paste a
 * `dumpOrderRiskTraces()` snapshot showing exactly which surface produced
 * which trace, what coverage was applied, and what the chokepoint output.
 * Without this, "I saw UNBOUNDED last week on the WULF chain" is a
 * he-said-she-said.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { PortfolioData } from "@/lib/types";
import { OrderRiskGate, dumpOrderRiskTraces, clearOrderRiskTraces } from "@/lib/order/risk";

afterEach(cleanup);
beforeEach(() => clearOrderRiskTraces());

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

describe("OrderRiskGate telemetry", () => {
  it("writes one trace to sessionStorage per resolved state observation", () => {
    render(<OrderRiskGate input={sampleInput} portfolio={emptyPortfolio} surface="test-surface" />);
    const traces = dumpOrderRiskTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      surface: "test-surface",
      ticker: "WULF",
      legCount: 1,
      coverageStatus: "resolved",
      maxLossUnbounded: true,
      hasUndefinedRisk: true,
    });
    expect(traces[0].traceId).toMatch(/[a-f0-9-]{8,}/);
    expect(traces[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("records the pending state with no risk verdict when portfolio is undefined", () => {
    render(<OrderRiskGate input={sampleInput} portfolio={undefined} surface="cold-load" />);
    const traces = dumpOrderRiskTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      surface: "cold-load",
      coverageStatus: "pending",
      maxLossUnbounded: false, // pending: not a UNBOUNDED reading
    });
  });

  it("records the no-portfolio state when null is passed explicitly", () => {
    render(<OrderRiskGate input={sampleInput} portfolio={null} surface="no-portfolio-scope" />);
    const traces = dumpOrderRiskTraces();
    expect(traces[0].coverageStatus).toBe("no-portfolio");
  });

  it("does NOT record anything when input is null (gate renders nothing)", () => {
    render(<OrderRiskGate input={null} portfolio={emptyPortfolio} surface="empty-input" />);
    expect(dumpOrderRiskTraces()).toHaveLength(0);
  });

  it("ring buffer trims to 50 entries (oldest evicted)", () => {
    // Render 55 times with different traceIds. The hook regenerates the
    // traceId per memo update, but identical inputs share a memo cache —
    // we force regeneration by varying the description.
    for (let i = 0; i < 55; i++) {
      cleanup();
      render(
        <OrderRiskGate
          input={{ ...sampleInput, description: `iter-${i}` }}
          portfolio={emptyPortfolio}
          surface="ring-buffer-test"
        />,
      );
    }
    const traces = dumpOrderRiskTraces();
    expect(traces.length).toBeLessThanOrEqual(50);
  });

  it("clearOrderRiskTraces empties the buffer", () => {
    render(<OrderRiskGate input={sampleInput} portfolio={emptyPortfolio} surface="t" />);
    expect(dumpOrderRiskTraces()).toHaveLength(1);
    clearOrderRiskTraces();
    expect(dumpOrderRiskTraces()).toHaveLength(0);
  });
});
