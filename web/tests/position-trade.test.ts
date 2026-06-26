import { describe, expect, it } from "vitest";
import {
  buildPositionTradeOrder,
  closingActionFor,
  type TradeTarget,
} from "../lib/order/positionTrade";
import type { PortfolioPosition } from "@/lib/types";

// A risk reversal like the screenshot: SHORT Call $1050 x3, LONG Put $800 x5.
// avg_cost is per-CONTRACT (already x100): short call $109.99/sh -> 10999,
// long put $59.00/sh -> 5900.
function riskReversal(): PortfolioPosition {
  return {
    id: 7,
    ticker: "MU",
    structure: "Ratio Reverse Risk Reversal 5x3 (P$800.0/C$1050.0)",
    structure_type: "Risk Reversal",
    direction: "COMBO",
    contracts: 5,
    expiry: "2026-07-17",
    entry_date: "2026-05-29",
    entry_cost: -3495,
    market_value: -46290,
    market_price_is_calculated: false,
    legs: [
      {
        direction: "SHORT",
        type: "Call",
        strike: 1050,
        contracts: 3,
        avg_cost: 10999,
        entry_cost: -32997,
        market_price: 133.93,
        market_price_is_calculated: false,
      },
      {
        direction: "LONG",
        type: "Put",
        strike: 800,
        contracts: 5,
        avg_cost: 5900,
        entry_cost: 29500,
        market_price: 41.0,
        market_price_is_calculated: false,
      },
    ],
  } as unknown as PortfolioPosition;
}

describe("closingActionFor", () => {
  it("combo closes with SELL", () => {
    expect(closingActionFor(riskReversal(), { kind: "combo" })).toBe("SELL");
  });
  it("long leg closes with SELL", () => {
    expect(closingActionFor(riskReversal(), { kind: "leg", index: 1 })).toBe("SELL");
  });
  it("short leg closes with BUY", () => {
    expect(closingActionFor(riskReversal(), { kind: "leg", index: 0 })).toBe("BUY");
  });
});

describe("buildPositionTradeOrder — combo", () => {
  it("SELL = close-out: combo payload with structure leg actions + closeOut basis", () => {
    const o = buildPositionTradeOrder({
      position: riskReversal(),
      target: { kind: "combo" },
      action: "SELL",
      quantity: 5,
      limitPrice: 2.0,
      tif: "DAY",
    })!;
    expect(o.isClosing).toBe(true);
    expect(o.payload.type).toBe("combo");
    expect(o.payload.action).toBe("SELL");
    // Leg actions encode STRUCTURE (SHORT call -> SELL, LONG put -> BUY).
    expect(o.payload.legs).toEqual([
      { expiry: "20260717", strike: 1050, right: "C", action: "SELL", ratio: 1 },
      { expiry: "20260717", strike: 800, right: "P", action: "BUY", ratio: 1 },
    ]);
    // closeOut basis = resolveEntryCost (signed sum of leg entry costs).
    // -32997 (short, sign -1 * |entry|) + 29500 (long) = -3497... resolveEntryCost
    // uses sign*|entry_cost|: short -1*32997 + long +1*29500 = -3497.
    expect(o.riskInput.closeOut?.entryCostDollars).toBe(-3497);
    expect(o.riskInput.totalCost).toBe(5 * 2.0 * 100);
  });

  it("BUY = add: hands legs to the augmenter (no closeOut)", () => {
    const o = buildPositionTradeOrder({
      position: riskReversal(),
      target: { kind: "combo" },
      action: "BUY",
      quantity: 5,
      limitPrice: 2.0,
      tif: "DAY",
    })!;
    expect(o.isClosing).toBe(false);
    expect(o.riskInput.closeOut).toBeUndefined();
    expect(o.riskInput.chainLegs).toHaveLength(2);
  });
});

describe("buildPositionTradeOrder — single leg", () => {
  it("SELL-to-close the LONG put: proceeds + realized P&L from per-contract basis", () => {
    const o = buildPositionTradeOrder({
      position: riskReversal(),
      target: { kind: "leg", index: 1 }, // long put $800, avg_cost 5900/contract
      action: "SELL",
      quantity: 5,
      limitPrice: 41.0,
      tif: "DAY",
    })!;
    expect(o.isClosing).toBe(true);
    expect(o.payload).toMatchObject({ type: "option", strike: 800, right: "P", action: "SELL", quantity: 5 });
    const proceeds = 5 * 41.0 * 100; // 20500
    expect(o.riskInput.totalCost).toBe(proceeds);
    expect(o.riskInput.totalLabel).toBe("Proceeds:");
    // basis = 5 * 5900 = 29500. pnl (computed by gate) = 20500 - 29500 = -9000.
    expect(o.riskInput.closeOut?.entryCostDollars).toBe(29500);
  });

  it("BUY-to-close the SHORT call: debit paid, basis is the original credit (negative)", () => {
    const o = buildPositionTradeOrder({
      position: riskReversal(),
      target: { kind: "leg", index: 0 }, // short call $1050, avg_cost 10999/contract
      action: "BUY",
      quantity: 3,
      limitPrice: 133.93,
      tif: "DAY",
    })!;
    expect(o.isClosing).toBe(true);
    expect(o.payload).toMatchObject({ type: "option", strike: 1050, right: "C", action: "BUY", quantity: 3 });
    const debit = 3 * 133.93 * 100; // 40179
    expect(o.riskInput.totalCost).toBe(-debit);
    expect(o.riskInput.totalLabel).toBe("Close Debit:");
    // basis negative = original credit. pnl = (-40179) - (-32997) = -7182.
    expect(o.riskInput.closeOut?.entryCostDollars).toBe(-(3 * 10999));
  });

  it("opening more of a leg routes through chainLegs (no closeOut)", () => {
    const o = buildPositionTradeOrder({
      position: riskReversal(),
      target: { kind: "leg", index: 1 }, // long put
      action: "BUY", // buy MORE of the long put = opening
      quantity: 2,
      limitPrice: 41.0,
      tif: "DAY",
    })!;
    expect(o.isClosing).toBe(false);
    expect(o.riskInput.closeOut).toBeUndefined();
    expect(o.riskInput.chainLegs).toEqual([
      { action: "BUY", right: "P", strike: 800, expiry: "2026-07-17", quantity: 2 },
    ]);
  });
});
