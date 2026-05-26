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
import {
  computeOrderRisk,
  augmentOrderLegsWithPortfolioCoverage,
  type OrderRiskLeg,
  type ChainOrderLeg,
} from "../lib/orderRisk";
import type { PortfolioData } from "../lib/types";

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

/* ---------------------------------------------------------------------------
 * Closing-trade coverage (SELL of a held LONG option is NOT a naked short).
 *
 * The 2026-05-20 P0 bug: a SELL of 65 long-call contracts when the user holds
 * exactly 65 contracts of that call was flagged "UNBOUNDED" by the order
 * ticket because the risk model had no signal that the trade was a close.
 *
 * Rule
 * ----
 *   SELL of N options where the held LONG of the same option is M:
 *     - If M >= N → pure close → bounded, maxLoss = 0 (no new exposure).
 *     - If M < N → only the (N - M) excess is naked; the M covered portion
 *       contributes zero structural risk. For a call this means the excess
 *       drives UNBOUNDED; for a put it drives the assignment-at-zero bound
 *       on (N - M) contracts.
 * -------------------------------------------------------------------------*/

describe("computeOrderRisk — closing-trade coverage", () => {
  it("SELL N long calls when holding exactly N → pure close, NOT unbounded", () => {
    // USAX bug repro: held 65 LONG $45 calls, selling 65 to close at $5.00.
    const closingLeg: OrderRiskLeg = {
      action: "SELL",
      right: "C",
      strike: 45,
      expiry: "20260620",
      quantity: 1,
      coveringLongContracts: 65,
    };
    const risk = computeOrderRisk([closingLeg], 5.0, 65);
    expect(risk.maxLossUnbounded).toBe(false);
    expect(risk.hasUndefinedRisk).toBe(false);
    expect(risk.undefinedRiskReason).toBeNull();
    expect(risk.maxLoss).toBe(0);
  });

  it("SELL M < N long calls (partial close) → still bounded, no naked excess", () => {
    // Holding 65 long, selling 64 → all 64 covered → bounded.
    const closingLeg: OrderRiskLeg = {
      action: "SELL",
      right: "C",
      strike: 45,
      expiry: "20260620",
      quantity: 1,
      coveringLongContracts: 65,
    };
    const risk = computeOrderRisk([closingLeg], 5.0, 64);
    expect(risk.maxLossUnbounded).toBe(false);
    expect(risk.hasUndefinedRisk).toBe(false);
  });

  it("SELL M > N long calls (oversell) → only the (M - N) excess is naked → UNBOUNDED", () => {
    // Holding 65 long, selling 66 → 1 contract is genuinely naked.
    const closingLeg: OrderRiskLeg = {
      action: "SELL",
      right: "C",
      strike: 45,
      expiry: "20260620",
      quantity: 1,
      coveringLongContracts: 65,
    };
    const risk = computeOrderRisk([closingLeg], 5.0, 66);
    expect(risk.maxLossUnbounded).toBe(true);
    expect(risk.hasUndefinedRisk).toBe(true);
    expect(risk.undefinedRiskReason).toMatch(/short call/i);
  });

  it("SELL N long puts when holding exactly N → pure close, NOT undefined risk", () => {
    // Held 30 LONG $100 puts → selling 30 to close at $2.50.
    const closingLeg: OrderRiskLeg = {
      action: "SELL",
      right: "P",
      strike: 100,
      expiry: "20260620",
      quantity: 1,
      coveringLongContracts: 30,
    };
    const risk = computeOrderRisk([closingLeg], 2.5, 30);
    expect(risk.hasUndefinedRisk).toBe(false);
    expect(risk.undefinedRiskReason).toBeNull();
    expect(risk.maxLoss).toBe(0);
  });

  it("SELL M > N long puts (oversell) → only (M - N) excess is a naked short put", () => {
    const closingLeg: OrderRiskLeg = {
      action: "SELL",
      right: "P",
      strike: 100,
      expiry: "20260620",
      quantity: 1,
      coveringLongContracts: 30,
    };
    // Sell 32 puts; 2 are naked → naked short put bound at strike-to-zero on 2 contracts.
    const risk = computeOrderRisk([closingLeg], 2.5, 32);
    expect(risk.maxLossUnbounded).toBe(false);
    expect(risk.hasUndefinedRisk).toBe(true);
    expect(risk.undefinedRiskReason).toMatch(/short put/i);
    // 2 naked × $100 strike × 100 multiplier - 2 × $2.50 × 100 premium = 20_000 - 500 = 19_500
    expect(risk.maxLoss).toBeCloseTo(19_500, 5);
  });

  it("no coverage signal → SELL of an option remains a naked short (backwards compat)", () => {
    // Same shape as the original "naked short call alone" test — without the
    // coverage field, behavior must not change.
    const risk = computeOrderRisk([leg("SELL", "C", 100)], 2, 1);
    expect(risk.maxLossUnbounded).toBe(true);
    expect(risk.hasUndefinedRisk).toBe(true);
  });
});

/* ---------------------------------------------------------------------------
 * Chain order builder → portfolio-coverage augmentation.
 *
 * The 2026-05-26 WULF bug: the operator held 77 LONG $17C exp 2027-01-15 and
 * clicked SELL on the $31C of the same expiry. The chain order builder
 * computed risk over the SELL leg in isolation, surfaced "UNBOUNDED", and
 * also displayed Max Gain × 77² because single-leg orders carry `quantity = N`
 * AND `comboQuantity = N` (both copies of the user's qty), which the
 * single-leg branch of computeOrderRisk multiplies together.
 *
 * augmentOrderLegsWithPortfolioCoverage exists so the chain order builder
 * can model the RESULTING POSITION (chain leg + held long legs of the same
 * underlying/expiry/right) without leaking the per-combo / per-contract
 * convention. Chain leg quantity is normalised to a per-combo ratio (1) with
 * total contracts carried in `comboQuantity`; same-right held longs are
 * injected as virtual BUY legs with `quantity = held_contracts / comboQuantity`.
 * Fractional ratios are deliberate — partial coverage surfaces as longRatio
 * less than shortRatio, which the existing legsAreBounded path resolves to
 * UNBOUNDED.
 * -------------------------------------------------------------------------*/

function buildPortfolio(positions: PortfolioData["positions"]): PortfolioData {
  return {
    positions,
    bankroll: 0,
    open_risk: 0,
    open_risk_pct: 0,
    convexity_score: null,
    convexity_breakdown: null,
    account_summary: null,
  } as unknown as PortfolioData;
}

function makePos(opts: {
  ticker: string;
  expiry: string;
  right: "Call" | "Put";
  strike: number;
  direction: "LONG" | "SHORT";
  contracts: number;
}): PortfolioData["positions"][number] {
  return {
    id: Math.floor(Math.random() * 10_000),
    ticker: opts.ticker,
    structure: opts.direction === "LONG" ? `Long ${opts.right}` : `Short ${opts.right}`,
    structure_type: opts.direction === "LONG" ? "Long Option" : "Short Option",
    risk_profile: "defined",
    expiry: opts.expiry,
    contracts: opts.contracts,
    direction: opts.direction,
    entry_cost: 0,
    max_risk: null,
    market_value: null,
    legs: [
      {
        direction: opts.direction,
        contracts: opts.contracts,
        type: opts.right,
        strike: opts.strike,
        entry_cost: 0,
        avg_cost: 0,
        market_price: null,
        market_value: null,
      },
    ],
    kelly_optimal: null,
    target: null,
    stop: null,
  } as unknown as PortfolioData["positions"][number];
}

function chainSell(strike: number, right: "C" | "P", quantity: number, expiry = "20270115"): ChainOrderLeg {
  return { action: "SELL", right, strike, expiry, quantity };
}
function chainBuy(strike: number, right: "C" | "P", quantity: number, expiry = "20270115"): ChainOrderLeg {
  return { action: "BUY", right, strike, expiry, quantity };
}

describe("augmentOrderLegsWithPortfolioCoverage — WULF-style spread coverage", () => {
  it("LONG 77x $17C + chain SELL 77x $31C same expiry → bull call spread, NOT unbounded", () => {
    // The exact WULF screenshot scenario. Without augmentation: UNBOUNDED.
    const portfolio = buildPortfolio([
      makePos({ ticker: "WULF", expiry: "2027-01-15", right: "Call", strike: 17, direction: "LONG", contracts: 77 }),
    ]);
    const { riskLegs, comboQuantity, coveringLegs } = augmentOrderLegsWithPortfolioCoverage(
      [chainSell(31, "C", 77)],
      "WULF",
      portfolio,
    );

    // Chain leg + one virtual long leg
    expect(riskLegs).toHaveLength(2);
    expect(comboQuantity).toBe(77);
    expect(coveringLegs).toHaveLength(1);
    expect(coveringLegs[0]).toMatchObject({ strike: 17, contracts: 77, right: "C" });

    // netPremium = -5.60 credit per share
    const risk = computeOrderRisk(riskLegs, -5.60, comboQuantity);
    expect(risk.maxLossUnbounded).toBe(false);
    expect(risk.hasUndefinedRisk).toBe(false);
    // Bull call CREDIT spread: long lower / short higher with credit received
    // means the structure can never lose money (proof in tasks/todo.md).
    expect(risk.maxLoss).toBe(0);
    // Max gain at S ≥ K_short: spread width × N × 100 + credit dollars
    //   = 14 × 77 × 100 + 5.60 × 77 × 100 = $107,800 + $43,120 = $150,920
    expect(risk.maxGain).toBeCloseTo(150_920, 0);
  });

  it("LONG 65x $17C + chain SELL 77x $31C → 12 contracts uncovered → UNBOUNDED", () => {
    const portfolio = buildPortfolio([
      makePos({ ticker: "WULF", expiry: "2027-01-15", right: "Call", strike: 17, direction: "LONG", contracts: 65 }),
    ]);
    const { riskLegs, comboQuantity } = augmentOrderLegsWithPortfolioCoverage(
      [chainSell(31, "C", 77)],
      "WULF",
      portfolio,
    );
    const risk = computeOrderRisk(riskLegs, -5.60, comboQuantity);
    expect(risk.maxLossUnbounded).toBe(true);
    expect(risk.hasUndefinedRisk).toBe(true);
    expect(risk.undefinedRiskReason).toMatch(/short call/i);
  });

  it("LONG 100x $17C + chain SELL 77x $31C → over-coverage, still bounded", () => {
    const portfolio = buildPortfolio([
      makePos({ ticker: "WULF", expiry: "2027-01-15", right: "Call", strike: 17, direction: "LONG", contracts: 100 }),
    ]);
    const { riskLegs, comboQuantity, coveringLegs } = augmentOrderLegsWithPortfolioCoverage(
      [chainSell(31, "C", 77)],
      "WULF",
      portfolio,
    );
    // Only 77 contracts of coverage modelled (capped at chain leg's qty); the
    // extra 23 long calls remain a separate held position — including them
    // would inflate Max Gain by the unbounded long-call upside.
    expect(coveringLegs[0].contracts).toBe(77);
    const risk = computeOrderRisk(riskLegs, -5.60, comboQuantity);
    expect(risk.maxLossUnbounded).toBe(false);
  });

  it("LONG $17C in expiry A + chain SELL $31C in expiry B → no coverage, UNBOUNDED", () => {
    const portfolio = buildPortfolio([
      makePos({ ticker: "WULF", expiry: "2026-09-18", right: "Call", strike: 17, direction: "LONG", contracts: 77 }),
    ]);
    const { riskLegs, comboQuantity, coveringLegs } = augmentOrderLegsWithPortfolioCoverage(
      [chainSell(31, "C", 77, "20270115")],
      "WULF",
      portfolio,
    );
    expect(coveringLegs).toHaveLength(0);
    expect(riskLegs).toHaveLength(1);
    const risk = computeOrderRisk(riskLegs, -5.60, comboQuantity);
    expect(risk.maxLossUnbounded).toBe(true);
  });

  it("LONG 30x $19P + chain SELL 30x $17P same expiry → bull put spread, bounded", () => {
    // Put-side symmetry: held LONG put at HIGHER strike covers short put at
    // LOWER strike (bull put spread).
    const portfolio = buildPortfolio([
      makePos({ ticker: "WULF", expiry: "2027-01-15", right: "Put", strike: 19, direction: "LONG", contracts: 30 }),
    ]);
    const { riskLegs, comboQuantity, coveringLegs } = augmentOrderLegsWithPortfolioCoverage(
      [chainSell(17, "P", 30)],
      "WULF",
      portfolio,
    );
    expect(coveringLegs).toHaveLength(1);
    expect(coveringLegs[0]).toMatchObject({ strike: 19, right: "P" });
    const risk = computeOrderRisk(riskLegs, -1.0, comboQuantity);
    expect(risk.maxLossUnbounded).toBe(false);
    expect(risk.hasUndefinedRisk).toBe(false);
  });

  it("LONG 30x $15P + chain SELL 30x $17P same expiry → long put at LOWER strike does NOT cover, undefined", () => {
    // A long put with K_long < K_short does NOT bound a short put — at S=0
    // the short owes K_short × 100 while the long pays only K_long × 100,
    // net loss = (K_short - K_long) × N × 100 (still finite, but undefined-risk).
    // The existing put-bounded model captures this as bounded numerically yet
    // surfaces undefined-risk because the loss is structural strike-to-zero.
    const portfolio = buildPortfolio([
      makePos({ ticker: "WULF", expiry: "2027-01-15", right: "Put", strike: 15, direction: "LONG", contracts: 30 }),
    ]);
    const { riskLegs, comboQuantity } = augmentOrderLegsWithPortfolioCoverage(
      [chainSell(17, "P", 30)],
      "WULF",
      portfolio,
    );
    const risk = computeOrderRisk(riskLegs, -0.50, comboQuantity);
    // Numerically bounded but classified as defined-risk via the long-put cap
    // (15-to-0 floor). Loss at S=0: (17 - 15) × 30 × 100 - 0.50 × 30 × 100
    //   = 6,000 - 1,500 = 4,500.
    expect(risk.maxLossUnbounded).toBe(false);
    expect(risk.maxLoss).toBeCloseTo(4_500, 0);
  });

  it("SHORT positions in portfolio are NOT injected as coverage", () => {
    // Held SHORT calls do not cover a new short call — they compound it.
    const portfolio = buildPortfolio([
      makePos({ ticker: "WULF", expiry: "2027-01-15", right: "Call", strike: 17, direction: "SHORT", contracts: 77 }),
    ]);
    const { riskLegs, coveringLegs } = augmentOrderLegsWithPortfolioCoverage(
      [chainSell(31, "C", 77)],
      "WULF",
      portfolio,
    );
    expect(coveringLegs).toHaveLength(0);
    expect(riskLegs).toHaveLength(1);
  });

  it("STK / non-option positions ignored even on same ticker", () => {
    // Stock can't cover an option leg — different secType. Filter must
    // require `type ∈ {Call, Put}` and a finite strike.
    const stockPos = {
      ...makePos({ ticker: "WULF", expiry: "", right: "Call", strike: 17, direction: "LONG", contracts: 1000 }),
      structure: "Long Stock",
      structure_type: "Stock",
      legs: [
        {
          direction: "LONG" as const,
          contracts: 1000,
          type: "Stock" as const,
          strike: null,
          entry_cost: 0,
          avg_cost: 0,
          market_price: null,
          market_value: null,
        },
      ],
    };
    const portfolio = buildPortfolio([stockPos as unknown as PortfolioData["positions"][number]]);
    const { coveringLegs } = augmentOrderLegsWithPortfolioCoverage(
      [chainSell(31, "C", 77)],
      "WULF",
      portfolio,
    );
    expect(coveringLegs).toHaveLength(0);
  });

  it("different ticker positions are not pulled in as coverage", () => {
    const portfolio = buildPortfolio([
      makePos({ ticker: "AAPL", expiry: "2027-01-15", right: "Call", strike: 17, direction: "LONG", contracts: 500 }),
    ]);
    const { coveringLegs } = augmentOrderLegsWithPortfolioCoverage(
      [chainSell(31, "C", 77)],
      "WULF",
      portfolio,
    );
    expect(coveringLegs).toHaveLength(0);
  });

  it("multiple covering positions at different strikes are summed", () => {
    const portfolio = buildPortfolio([
      makePos({ ticker: "WULF", expiry: "2027-01-15", right: "Call", strike: 17, direction: "LONG", contracts: 50 }),
      makePos({ ticker: "WULF", expiry: "2027-01-15", right: "Call", strike: 19, direction: "LONG", contracts: 27 }),
    ]);
    const { riskLegs, coveringLegs } = augmentOrderLegsWithPortfolioCoverage(
      [chainSell(31, "C", 77)],
      "WULF",
      portfolio,
    );
    expect(coveringLegs).toHaveLength(2);
    expect(coveringLegs.map((l) => l.strike).sort((a, b) => a - b)).toEqual([17, 19]);
    expect(riskLegs).toHaveLength(3);
    const risk = computeOrderRisk(riskLegs, -5.60, 77);
    expect(risk.maxLossUnbounded).toBe(false);
  });

  it("BUY chain legs are not augmented (no portfolio coverage modelling for opening longs)", () => {
    const portfolio = buildPortfolio([
      makePos({ ticker: "WULF", expiry: "2027-01-15", right: "Call", strike: 17, direction: "LONG", contracts: 77 }),
    ]);
    const { riskLegs, coveringLegs } = augmentOrderLegsWithPortfolioCoverage(
      [chainBuy(31, "C", 77)],
      "WULF",
      portfolio,
    );
    // Opening additional longs doesn't need synthetic coverage; the BUY leg
    // is its own bounded-loss instrument.
    expect(coveringLegs).toHaveLength(0);
    expect(riskLegs).toHaveLength(1);
  });

  it("no portfolio passed → returns chain legs verbatim with quantity normalised", () => {
    const { riskLegs, comboQuantity, coveringLegs } = augmentOrderLegsWithPortfolioCoverage(
      [chainSell(31, "C", 77)],
      "WULF",
      null,
    );
    expect(coveringLegs).toHaveLength(0);
    expect(riskLegs).toHaveLength(1);
    // Quantity normalised: single-leg ratio = 1, comboQuantity carries N.
    expect(riskLegs[0].quantity).toBe(1);
    expect(comboQuantity).toBe(77);
  });
});

describe("augmentOrderLegsWithPortfolioCoverage — quantity² regression", () => {
  it("single-leg chain order with quantity=77 produces contracts=77 (NOT 77²)", () => {
    // Before fix: chain OrderBuilder passed leg.quantity=77 AND comboQuantity=77
    // to computeOrderRisk, so the single-leg branch computed contracts = 77×77 =
    // 5,929, inflating Max Gain to $3,320,240 instead of $43,120 on a $5.60
    // credit for 77 contracts.
    const { riskLegs, comboQuantity } = augmentOrderLegsWithPortfolioCoverage(
      [chainSell(100, "C", 77)],
      "WULF",
      null,
    );
    // No coverage available — single naked short call. Max gain = premium × N × 100.
    const risk = computeOrderRisk(riskLegs, -5.60, comboQuantity);
    expect(risk.maxGain).toBeCloseTo(5.60 * 77 * 100, 0); // $43,120
    expect(risk.maxGain).not.toBeCloseTo(5.60 * 77 * 77 * 100, 0); // NOT $3,320,240
  });

  it("two-leg chain combo with equal quantities preserves per-combo ratios", () => {
    // Regression guard: a custom 50x/50x vertical built via chain clicks must
    // not double-count quantity. Both legs land with `quantity = 1` ratio and
    // comboQuantity = 50.
    const { riskLegs, comboQuantity } = augmentOrderLegsWithPortfolioCoverage(
      [chainBuy(100, "C", 50), chainSell(110, "C", 50)],
      "AAPL",
      null,
    );
    expect(comboQuantity).toBe(50);
    expect(riskLegs.every((l) => l.quantity === 1)).toBe(true);
    const risk = computeOrderRisk(riskLegs, 2, comboQuantity);
    // Bull call spread, 50 contracts, $2 debit per share → $10,000 max loss.
    expect(risk.maxLoss).toBeCloseTo(10_000, 0);
    expect(risk.maxGain).toBeCloseTo(40_000, 0); // (10 width - 2 debit) × 50 × 100
  });
});
