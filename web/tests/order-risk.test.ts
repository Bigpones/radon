/**
 * Tests for web/lib/orderRisk.ts — the unified max-loss / max-gain calc that
 * backs the order builder, the per-position order tab, and the instrument
 * modal.
 *
 * Each case spells out the structural intent of the trade so a regression
 * is immediately attributable to a real instrument the user might build.
 *
 * Reference for the canonical "Risk Reversal" case: the 2026-05-19 P0 bug
 * (`AAOI 50× SELL $150P / BUY $200C @ $1 debit`) where the UI displayed
 * `Max Loss: $5,000` and reality was ≈$755,000 of assignment exposure.
 */
import { describe, it, expect } from "vitest";
import { computeOrderRisk, type OrderRiskLeg } from "../lib/orderRisk";

function leg(
  action: "BUY" | "SELL",
  right: "C" | "P",
  strike: number,
  quantity = 1,
  expiry = "20260320",
): OrderRiskLeg {
  return { action, right, strike, expiry, quantity };
}

describe("computeOrderRisk — defined-risk structures", () => {
  it("bull call spread (long lower, short higher) → max loss = debit, max gain = width - debit", () => {
    const legs = [
      leg("BUY", "C", 100),
      leg("SELL", "C", 110),
    ];
    // $2 net debit per share, 1 contract
    const risk = computeOrderRisk(legs, 2, 1);
    expect(risk.maxLossUnbounded).toBe(false);
    expect(risk.maxGainUnbounded).toBe(false);
    expect(risk.hasUndefinedRisk).toBe(false);
    expect(risk.maxLoss).toBe(200);     // debit × 100
    expect(risk.maxGain).toBe(800);     // (10 - 2) × 100
  });

  it("bull put spread (short higher, long lower) → max loss = width - credit, max gain = credit", () => {
    const legs = [
      leg("SELL", "P", 100),
      leg("BUY", "P", 90),
    ];
    // Net CREDIT of $3 → netPremium negative
    const risk = computeOrderRisk(legs, -3, 1);
    expect(risk.maxLossUnbounded).toBe(false);
    expect(risk.hasUndefinedRisk).toBe(false);
    expect(risk.maxLoss).toBe(700);   // (100-90)×100 - 300 credit = 700
    expect(risk.maxGain).toBe(300);   // credit received
  });

  it("bear put spread (long higher, short lower) → max loss = debit, max gain = width - debit", () => {
    const legs = [
      leg("BUY", "P", 110),
      leg("SELL", "P", 100),
    ];
    const risk = computeOrderRisk(legs, 2, 1);
    expect(risk.maxLoss).toBe(200);
    expect(risk.maxGain).toBe(800);
    expect(risk.hasUndefinedRisk).toBe(false);
  });

  it("iron condor (long wings cap both sides) → max loss = wider wing - net credit", () => {
    // Long 90P / Short 95P / Short 105C / Long 110C
    const legs = [
      leg("BUY", "P", 90),
      leg("SELL", "P", 95),
      leg("SELL", "C", 105),
      leg("BUY", "C", 110),
    ];
    // Net credit $1.50 → max loss per side = 5 - 1.50 = $3.50 × 100 = $350
    const risk = computeOrderRisk(legs, -1.5, 1);
    expect(risk.maxLossUnbounded).toBe(false);
    expect(risk.hasUndefinedRisk).toBe(false);
    expect(risk.maxLoss).toBeCloseTo(350, 5);
    expect(risk.maxGain).toBe(150);
  });

  it("long straddle (long call + long put same strike) → max loss = total debit, max gain unbounded", () => {
    const legs = [
      leg("BUY", "C", 100),
      leg("BUY", "P", 100),
    ];
    const risk = computeOrderRisk(legs, 5, 1);
    expect(risk.maxLossUnbounded).toBe(false);
    expect(risk.maxLoss).toBeCloseTo(500, 5);
    expect(risk.maxGainUnbounded).toBe(true);
    expect(risk.hasUndefinedRisk).toBe(false);
  });
});

describe("computeOrderRisk — undefined-risk structures", () => {
  it("naked short call alone → max loss UNBOUNDED", () => {
    const risk = computeOrderRisk([leg("SELL", "C", 100)], -2, 1);
    expect(risk.maxLossUnbounded).toBe(true);
    expect(risk.maxLoss).toBeNull();
    expect(risk.hasUndefinedRisk).toBe(true);
    expect(risk.undefinedRiskReason).toMatch(/short call/i);
  });

  it("naked short put alone → max loss = strike × 100 - premium received", () => {
    // SHORT $100 put, receive $2 credit, 1 contract
    const risk = computeOrderRisk([leg("SELL", "P", 100)], -2, 1);
    expect(risk.maxLossUnbounded).toBe(false);
    expect(risk.hasUndefinedRisk).toBe(true);
    expect(risk.undefinedRiskReason).toMatch(/short put/i);
    // 100 × 100 - 2 × 100 = $9,800
    expect(risk.maxLoss).toBeCloseTo(9800, 5);
    expect(risk.maxGain).toBe(200);
  });

  it("risk reversal — SHORT PUT + LONG CALL → naked put bound at strike-to-zero", () => {
    // The 2026-05-19 P0 case: AAOI 50× SELL $150P + BUY $200C @ $1 net debit
    // Expected: $150 × 50 × 100 = $750,000 assignment risk + $5,000 net debit
    //         ≈ $755,000
    const legs = [
      leg("SELL", "P", 150),
      leg("BUY", "C", 200),
    ];
    const risk = computeOrderRisk(legs, 1.0, 50);
    expect(risk.maxLossUnbounded).toBe(false);
    expect(risk.hasUndefinedRisk).toBe(true);
    expect(risk.undefinedRiskReason).toMatch(/short put/i);
    // Naked short put 150 × 50 × 100 = 750,000; net debit 1 × 50 × 100 = 5,000
    expect(risk.maxLoss).toBeCloseTo(755_000, 0);
    // Max gain is unbounded because long call has unbounded upside
    expect(risk.maxGainUnbounded).toBe(true);
  });

  it("risk reversal — LONG PUT + SHORT CALL → uncovered short call → UNBOUNDED", () => {
    const legs = [
      leg("BUY", "P", 150),
      leg("SELL", "C", 200),
    ];
    const risk = computeOrderRisk(legs, -1.0, 50);
    expect(risk.maxLossUnbounded).toBe(true);
    expect(risk.maxLoss).toBeNull();
    expect(risk.hasUndefinedRisk).toBe(true);
  });

  it("short straddle → UNBOUNDED via short call leg", () => {
    const legs = [
      leg("SELL", "C", 100),
      leg("SELL", "P", 100),
    ];
    const risk = computeOrderRisk(legs, -5, 1);
    expect(risk.maxLossUnbounded).toBe(true);
    expect(risk.hasUndefinedRisk).toBe(true);
  });

  it("jade lizard (short put + short call spread) → bounded on call side, naked short put surfaces undefined risk", () => {
    // Short 90P + Short 100C + Long 105C — call side capped, put side naked
    const legs = [
      leg("SELL", "P", 90),
      leg("SELL", "C", 100),
      leg("BUY", "C", 105),
    ];
    const risk = computeOrderRisk(legs, -3, 1);
    expect(risk.maxLossUnbounded).toBe(false);
    expect(risk.hasUndefinedRisk).toBe(true);
    expect(risk.undefinedRiskReason).toMatch(/short put/i);
    // Put side at S=0: 90 × 1 = 9000. Call spread side: max 500 (width). Take max + net cash.
    // Put side dominates: 90×100 = 9000 intrinsic, minus $300 net credit = 8700.
    expect(risk.maxLoss).toBeCloseTo(8700, 5);
  });
});

describe("computeOrderRisk — single-leg paths", () => {
  it("long call alone → max loss = premium paid, max gain unbounded", () => {
    const risk = computeOrderRisk([leg("BUY", "C", 100)], 2, 1);
    expect(risk.maxLoss).toBe(200);
    expect(risk.maxGainUnbounded).toBe(true);
    expect(risk.hasUndefinedRisk).toBe(false);
  });

  it("long put alone → max loss = premium paid, max gain = (strike - premium) × 100", () => {
    const risk = computeOrderRisk([leg("BUY", "P", 100)], 3, 1);
    expect(risk.maxLoss).toBe(300);
    expect(risk.maxGain).toBe(9700);  // (100 - 3) × 100
  });
});

describe("computeOrderRisk — ratio + asymmetric structures", () => {
  it("call ratio backspread (long 2 × 110C, short 1 × 100C) → bounded (more longs than shorts)", () => {
    const legs = [
      leg("BUY", "C", 110, 2),
      leg("SELL", "C", 100, 1),
    ];
    // ratio counts: 2 long vs 1 short. Net long → bounded above.
    // Intrinsic call-side loss between K=100 and K=110: cum ratio = -1 (one
    // short uncovered in that window) → segment loses 1 × 10 = 10 per comb.
    const risk = computeOrderRisk(legs, 0, 1);
    expect(risk.maxLossUnbounded).toBe(false);
    expect(risk.maxLoss).toBeCloseTo(1000, 5); // 10-wide trough × 100
  });

  it("call ratio spread (short 2 × 110C, long 1 × 100C) → UNBOUNDED (more shorts than longs)", () => {
    const legs = [
      leg("BUY", "C", 100, 1),
      leg("SELL", "C", 110, 2),
    ];
    const risk = computeOrderRisk(legs, -2, 1);
    expect(risk.maxLossUnbounded).toBe(true);
    expect(risk.hasUndefinedRisk).toBe(true);
  });

  it("long call butterfly (long 1×95C, short 2×100C, long 1×105C) → max loss = net debit", () => {
    const legs = [
      leg("BUY", "C", 95, 1),
      leg("SELL", "C", 100, 2),
      leg("BUY", "C", 105, 1),
    ];
    // $1 net debit
    const risk = computeOrderRisk(legs, 1, 1);
    expect(risk.maxLossUnbounded).toBe(false);
    expect(risk.maxLoss).toBeCloseTo(100, 5); // net debit
    expect(risk.maxGain).toBeCloseTo(400, 5); // (5 wing - 1 debit) × 100
  });

  it("calendar spread placeholder — different expiries handled at leg granularity (no crash)", () => {
    // Calendar can't be priced at one instant via this model; verify it
    // doesn't throw and surfaces what it can.
    const legs = [
      { ...leg("BUY", "C", 100), expiry: "20260619" },
      { ...leg("SELL", "C", 100), expiry: "20260320" },
    ];
    const risk = computeOrderRisk(legs, 1, 1);
    expect(risk.maxLossUnbounded).toBe(false);
  });
});

describe("computeOrderRisk — empty / edge inputs", () => {
  it("empty leg list returns null risk fields", () => {
    const risk = computeOrderRisk([], 0, 1);
    expect(risk.maxLoss).toBeNull();
    expect(risk.maxGain).toBeNull();
    expect(risk.hasUndefinedRisk).toBe(false);
  });

  it("zero quantity returns null risk fields", () => {
    const risk = computeOrderRisk([leg("BUY", "C", 100)], 2, 0);
    expect(risk.maxLoss).toBeNull();
  });
});
