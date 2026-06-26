/**
 * @vitest-environment jsdom
 *
 * Component-level regression for the 2026-05-19 P0 bug:
 * the OrderConfirmSummary must (1) render the corrected dollar Max Loss
 * for naked-short structures, (2) surface a Gate 1 "Undefined risk"
 * warning, and (3) render "UNBOUNDED" for fully unbounded structures.
 *
 * These cases mirror the user's AAOI Risk Reversal scenario plus the
 * naked-short-call counterpart.
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { OrderConfirmSummary } from "../lib/order/components/OrderConfirmSummary";
import type { OrderPresentationSummary } from "../lib/order/types";
// Test-only brand helper. Production code routes through `<OrderRiskGate>`;
// these render tests just want to exercise `<OrderConfirmSummary>`'s
// presentation logic for given field values, so we attach the brand
// directly to bypass the augmentation pipeline.
import { brandAugmentedSummaryForTest } from "../lib/order/risk/__test_only__";

const augment = brandAugmentedSummaryForTest;

afterEach(cleanup);

describe("OrderConfirmSummary — undefined risk surfacing", () => {
  it("renders the corrected 6-figure Max Loss for the AAOI risk reversal", () => {
    const summary: OrderPresentationSummary = {
      description: "Risk Reversal @ $1.00",
      totalCost: 5000,
      maxGain: null,
      maxGainUnbounded: true,
      maxLoss: 755_000, // strike-to-zero stress for naked short put
      maxLossUnbounded: false,
      undefinedRiskReason: "Naked short put",
    };
    const { getByTestId, container } = render(
      <OrderConfirmSummary summary={augment(summary)} variant="info" />,
    );
    // Warning surface is mandatory
    const warning = getByTestId("order-undefined-risk-warning");
    expect(warning).toBeTruthy();
    expect(warning.textContent).toMatch(/GATE 1/i);
    expect(warning.textContent).toMatch(/short put/i);

    // Max Loss is rendered as a 6-figure dollar number, NOT $5,000
    const text = container.textContent ?? "";
    expect(text).toMatch(/Max Loss:/);
    expect(text).toMatch(/\$755,000/);
    expect(text).not.toMatch(/Max Loss:\$5,000/); // the bug shape

    // Max Gain rendered as UNBOUNDED (long call upside)
    expect(text).toMatch(/UNBOUNDED/);
  });

  it("renders UNBOUNDED for a naked short call (full undefined-risk path)", () => {
    const summary: OrderPresentationSummary = {
      description: "Short Call @ $5.00",
      totalCost: -500,
      maxGain: 500,
      maxLoss: null,
      maxLossUnbounded: true,
      undefinedRiskReason: "Uncovered short call",
    };
    const { container } = render(<OrderConfirmSummary summary={augment(summary)} variant="info" />);
    const text = container.textContent ?? "";
    expect(text).toMatch(/Max Loss:/);
    expect(text).toMatch(/UNBOUNDED/);
    expect(text).toMatch(/GATE 1/i);
    expect(text).toMatch(/short call/i);
  });

  it("does NOT render the warning for a defined-risk bull call spread", () => {
    const summary: OrderPresentationSummary = {
      description: "Bull Call Spread @ $2.00",
      totalCost: 200,
      maxGain: 800,
      maxLoss: 200,
      maxLossUnbounded: false,
      undefinedRiskReason: null,
    };
    const { container, queryByTestId } = render(
      <OrderConfirmSummary summary={augment(summary)} variant="info" />,
    );
    expect(queryByTestId("order-undefined-risk-warning")).toBeNull();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/UNBOUNDED/);
    expect(text).toMatch(/\$200/);  // max loss
    expect(text).toMatch(/\$800/);  // max gain
  });
});
