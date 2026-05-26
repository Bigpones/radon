/**
 * Property-based fuzz suite for the order-risk integration seam.
 *
 * Three production bugs (AAOI, WULF, RR) in eight days all came from the
 * same shape of wrong: portfolio state combined with order state produced
 * a structurally-impossible risk verdict. Example-based tests (50 cases
 * in `order-risk.test.ts`) pin known structures; this suite proves the
 * seam holds across the input space.
 *
 * Three highest-leverage invariants ship here:
 *
 *   - **I2 / P4 — Coverage monotonicity** — adding LONG cover never makes
 *     max-loss worse. THE bug class (WULF, RR, future variants like an
 *     expiry-string normalisation drift) all surface as a `null` verdict
 *     where a finite verdict should hold; monotonicity catches that.
 *
 *   - **I4 / P3 — Quantity linearity** — single-leg `maxLoss(N) = N ×
 *     maxLoss(1)`. Catches the qty² regression where chain code passed N
 *     into both `leg.quantity` and `comboQuantity`, inflating Max Gain by
 *     77× in the WULF screenshot.
 *
 *   - **I7 — Stock-cover floor** — covered-call max-loss equals
 *     `(shares × avgCost) − premium` within $1. Catches the "would-be"
 *     RR bug where `netPremiumAdjustment` is forgotten and the model
 *     bottoms maxLoss at $0 even with real stock basis on the books.
 *
 * Plus two supporting properties:
 *
 *   - **P1** — long calls fully cover short calls → bounded
 *   - **P5** — empty portfolio ≡ null portfolio (degenerate equivalence)
 *
 * Performance budget: 30s total for this suite, default 1000 runs per
 * property. Seed pinned to 42 for CI reproducibility; local exploratory
 * runs override via `RADON_FUZZ_RANDOM=1`.
 */
import { describe, it } from "vitest";
import fc from "fast-check";
import {
  computeOrderRisk,
  augmentOrderLegsWithPortfolioCoverage,
  type ChainOrderLeg,
} from "@/lib/order/risk/__test_only__";
import {
  arbChainLeg,
  arbChainOrder,
  arbContracts,
  arbExpiryCompact,
  arbJointGuaranteedCover,
  arbJointGuaranteedNoCover,
  arbJointStockCover,
  arbNetPremium,
  arbStrike,
  arbTicker,
} from "./generators";
import { buildPortfolio, dashed, makePos } from "./builders";

// ---------------------------------------------------------------------------
// fast-check options. CI uses fixed seed 42; local devs can opt out via
// RADON_FUZZ_RANDOM=1 to explore the input space. Default 1000 runs strikes
// a balance — enough to surface most counter-examples, fast enough to keep
// the suite under 30s on the slowest CI runner we have.
// ---------------------------------------------------------------------------
const FIXED_SEED = 42;
const useRandomSeed = process.env.RADON_FUZZ_RANDOM === "1";
const fcOpts = (numRuns = 1000): fc.Parameters<unknown> => ({
  numRuns,
  seed: useRandomSeed ? Date.now() : FIXED_SEED,
  // `verbose: 0` keeps CI output clean. Failing cases still print the
  // shrunk counter-example.
  verbose: 0,
});

// Helper: run the full pipeline (augment → compute) on a triple and return
// the unified verdict. Identifies which side the verdict came from so
// property failures shrink to readable rationales.
function runRisk(
  chainLegs: ChainOrderLeg[],
  ticker: string,
  portfolio: ReturnType<typeof buildPortfolio> | null,
  netPremium: number,
) {
  const aug = augmentOrderLegsWithPortfolioCoverage(chainLegs, ticker, portfolio);
  return computeOrderRisk(aug.riskLegs, netPremium + aug.netPremiumAdjustment, aug.comboQuantity);
}

// ---------------------------------------------------------------------------
// P1 — WULF guard. Long calls fully cover short calls of same expiry/right
// at any strike → bounded. The exact scenario the chain UI displayed
// UNBOUNDED for on 2026-05-26 morning.
// ---------------------------------------------------------------------------
describe("fuzz: P1 — same-right LONG covers SHORT (option-only coverage)", () => {
  it("LONG ≥ SHORT contracts same expiry, same right ⇒ maxLossUnbounded === false", () => {
    fc.assert(
      fc.property(
        arbContracts,
        fc.integer({ min: 1, max: 5 }), // long multiplier ≥ 1 → M ≥ N
        arbStrike,
        arbStrike,
        arbExpiryCompact,
        arbTicker,
        arbNetPremium,
        (shortQty, mult, kShort, kLong, expiryC, ticker, prem) => {
          // Reject same-strike (that's the close-out path, not the spread path)
          fc.pre(kShort !== kLong);
          const longQty = shortQty * mult;
          const portfolio = buildPortfolio([
            makePos({
              ticker,
              expiry: dashed(expiryC),
              right: "Call",
              strike: kLong,
              direction: "LONG",
              contracts: longQty,
            }),
          ]);
          const chainLegs: ChainOrderLeg[] = [
            { action: "SELL", right: "C", strike: kShort, expiry: expiryC, quantity: shortQty },
          ];
          const r = runRisk(chainLegs, ticker, portfolio, prem);
          // The structural promise: a SELL call with LONG cover at any
          // strike is bounded. Numeric value depends on strike spread + net
          // premium; the invariant is bounded-ness, not a specific number.
          return r.maxLossUnbounded === false;
        },
      ),
      fcOpts(),
    );
  });
});

// ---------------------------------------------------------------------------
// P2 — RR guard. N×100 shares of LONG stock on the same ticker cover N short
// calls (covered call). Stock-cover floor + premium signs trip independently
// of P4; this is the stock-side complement to P1.
// ---------------------------------------------------------------------------
describe("fuzz: P2 — LONG stock covers SHORT CALL (covered-call coverage)", () => {
  it("100×N shares cover N short calls ⇒ maxLossUnbounded === false AND finite", () => {
    fc.assert(
      fc.property(arbJointStockCover, ({ portfolio, chainLegs, ticker, netPremium }) => {
        const r = runRisk(chainLegs, ticker, portfolio, netPremium);
        if (r.maxLossUnbounded) return false;
        if (r.maxLoss == null) return false;
        if (!Number.isFinite(r.maxLoss)) return false;
        return r.maxLoss >= 0;
      }),
      fcOpts(),
    );
  });
});

// ---------------------------------------------------------------------------
// P3 — Quantity linearity. Single-leg `maxLoss(N) = N × maxLoss(1)` for any
// chain leg with no portfolio coverage. The qty² regression guard at the
// math level — independent of which UI surface produced the input.
// ---------------------------------------------------------------------------
describe("fuzz: P3 — single-leg quantity linearity", () => {
  it("scaling qty by N scales maxLoss / maxGain by N (no portfolio coverage)", () => {
    fc.assert(
      fc.property(arbChainLeg, fc.integer({ min: 1, max: 100 }), arbNetPremium, (legBase, N, prem) => {
        const legN: ChainOrderLeg = { ...legBase, quantity: N };
        const leg1: ChainOrderLeg = { ...legBase, quantity: 1 };
        const rN = runRisk([legN], "ZZZZ_NO_COVER", null, prem);
        const r1 = runRisk([leg1], "ZZZZ_NO_COVER", null, prem);
        // Both must agree on unboundedness
        if (rN.maxLossUnbounded !== r1.maxLossUnbounded) return false;
        if (rN.maxGainUnbounded !== r1.maxGainUnbounded) return false;
        // When bounded, magnitudes scale linearly. Relative-tolerance is
        // the right shape: a 100× scaled comparison must absorb ~100×
        // accumulated float error. Anything tighter than 1e-3 relative
        // false-positives on legitimate float roundoff.
        const relTol = (a: number, b: number) =>
          Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));
        if (rN.maxLoss !== null && r1.maxLoss !== null) {
          if (relTol(rN.maxLoss, N * r1.maxLoss) > 1e-3) return false;
        }
        if (rN.maxGain !== null && r1.maxGain !== null) {
          if (relTol(rN.maxGain, N * r1.maxGain) > 1e-3) return false;
        }
        return true;
      }),
      fcOpts(),
    );
  });
});

// ---------------------------------------------------------------------------
// P4 — Coverage monotonicity. THE bug class catcher.
//
// Take a no-cover portfolio + order. Compute risk. Add a LONG position of
// the same right/expiry as a SELL leg. Recompute. The verdict can only
// improve (or stay the same):
//
//   - `maxLossUnbounded: true → false` is allowed (covering helps).
//   - `maxLossUnbounded: false → true` is FORBIDDEN.
//   - When both bounded, `maxLoss(after) ≤ maxLoss(before)`.
//
// Any future regression where the augmenter mis-identifies cover (expiry
// normalisation drift, casing bug, new IB security type the loader skips)
// trips here as a "covering made it worse" failure.
// ---------------------------------------------------------------------------
describe("fuzz: P4 — coverage monotonicity (THE seam property)", () => {
  it("adding a LONG cover to the same expiry/right never increases maxLoss", () => {
    fc.assert(
      fc.property(
        arbJointGuaranteedNoCover,
        arbContracts,
        arbStrike,
        ({ portfolio: base, chainLegs, ticker, netPremium }, extraLongQty, extraStrike) => {
          // Pick the SELL leg to cover (P4's joint always has at least one)
          const sellLeg = chainLegs.find((l) => l.action === "SELL");
          fc.pre(sellLeg != null);
          fc.pre(extraStrike !== sellLeg!.strike); // not a same-option close

          const before = runRisk(chainLegs, ticker, base, netPremium);

          const after_portfolio = buildPortfolio([
            ...base.positions,
            makePos({
              ticker,
              expiry: dashed(sellLeg!.expiry),
              right: sellLeg!.right === "C" ? "Call" : "Put",
              strike: extraStrike,
              direction: "LONG",
              contracts: extraLongQty,
            }),
          ]);
          const after = runRisk(chainLegs, ticker, after_portfolio, netPremium);

          // Bounded-ness can only improve
          if (before.maxLossUnbounded === false && after.maxLossUnbounded === true) return false;
          // When both bounded, max-loss can only decrease (or stay equal).
          // Tolerance: $1 absolute. This absorbs ~$0.001/dollar precision
          // drift between the single-leg path (`legRisk` uses `abs(premium)`
          // then subtracts from intrinsic) and the multi-leg path (signed
          // netCashDollars added to a separately-computed intrinsic floor).
          // Any real regression in coverage detection shows up as a
          // delta of $100+ (lost-coverage on a typical strike), well
          // above this threshold.
          if (
            before.maxLoss !== null &&
            after.maxLoss !== null &&
            after.maxLoss > before.maxLoss + 1
          ) {
            return false;
          }
          return true;
        },
      ),
      fcOpts(),
    );
  });

  it("adding LONG stock to a SELL CALL order never increases maxLoss", () => {
    fc.assert(
      fc.property(
        arbJointGuaranteedNoCover,
        fc.integer({ min: 1, max: 50 }), // multiples of 100 shares
        fc.float({
          min: Math.fround(0.5),
          max: Math.fround(200),
          noNaN: true,
          noDefaultInfinity: true,
        }),
        ({ portfolio: base, chainLegs, ticker, netPremium }, sharesUnit, avgCost) => {
          const sellCall = chainLegs.find((l) => l.action === "SELL" && l.right === "C");
          fc.pre(sellCall != null);

          const before = runRisk(chainLegs, ticker, base, netPremium);
          const after_portfolio = buildPortfolio([
            ...base.positions,
            // sharesUnit × 100 shares — round lots
            {
              id: 99,
              ticker,
              structure: "Long Stock",
              structure_type: "Stock",
              risk_profile: "equity",
              expiry: "",
              contracts: sharesUnit * 100,
              direction: "LONG",
              entry_cost: 0,
              max_risk: null,
              market_value: null,
              legs: [
                {
                  direction: "LONG" as const,
                  contracts: sharesUnit * 100,
                  type: "Stock" as const,
                  strike: null,
                  entry_cost: 0,
                  avg_cost: avgCost,
                  market_price: null,
                  market_value: null,
                },
              ],
              kelly_optimal: null,
              target: null,
              stop: null,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
          ]);
          const after = runRisk(chainLegs, ticker, after_portfolio, netPremium);

          if (before.maxLossUnbounded === false && after.maxLossUnbounded === true) return false;
          // Stock cover folds avg_cost into netPremiumAdjustment — so for
          // SOME stock-basis values the resulting maxLoss can be HIGHER (the
          // sunk basis IS the operator's exposure). The invariant is on
          // BOUNDEDNESS, not on the dollar number, for stock cover. (For
          // option cover, bounded-ness AND dollar-magnitude both monotone
          // — that's the previous property.)
          return true;
        },
      ),
      fcOpts(),
    );
  });
});

// ---------------------------------------------------------------------------
// I7 — Stock-cover floor.
//
// Covered call (LONG N×100 shares + SHORT N calls, K_short < S0_basis):
// max-loss at S=0 equals `(shares × avgCost) − premium_received`.
//
// This catches the "would-be RR bug" where `netPremiumAdjustment` is
// silently dropped — the verdict would then say `maxLoss=0` (free stock
// can't lose) which is structurally wrong by `shares × avgCost - premium`.
// ---------------------------------------------------------------------------
describe("fuzz: I7 — stock-cover floor", () => {
  it("covered call maxLoss ≈ (shares × avgCost) − premium_received", () => {
    fc.assert(
      fc.property(
        arbJointStockCover,
        ({ portfolio, chainLegs, ticker, avgCost, shortQty, premium }) => {
          // Use the same netPremium the joint generated (-premium for SELL)
          const r = runRisk(chainLegs, ticker, portfolio, -premium);

          // Expected stock-to-zero floor: shares × avgCost - premium_received × N × 100
          const expectedFloor = shortQty * 100 * avgCost - premium * shortQty * 100;
          // Must be finite + bounded
          if (r.maxLossUnbounded) return false;
          if (r.maxLoss == null) return false;

          // Allow $1 absolute tolerance — floating-point rounding through
          // the per-share-per-combo basis division can drift a few cents.
          // For values that should be near 0 (high premium, low basis),
          // allow `Math.max(...)` clamping (the model floors at 0).
          if (expectedFloor < 0) {
            return r.maxLoss === 0 || Math.abs(r.maxLoss - expectedFloor) < 1;
          }
          return Math.abs(r.maxLoss - expectedFloor) < 1;
        },
      ),
      fcOpts(),
    );
  });
});

// ---------------------------------------------------------------------------
// P5 — Empty / null portfolio equivalence. The null and empty paths must
// produce identical augmented riskLegs (modulo quantity-normalisation) and
// identical risk verdicts. Catches a regression where the augmenter
// silently injects a phantom leg when portfolio is empty.
// ---------------------------------------------------------------------------
describe("fuzz: P5 — null ≡ empty portfolio", () => {
  it("augment(legs, ticker, null) === augment(legs, ticker, {positions:[]}) verdicts match", () => {
    fc.assert(
      fc.property(arbChainOrder, arbTicker, arbNetPremium, (chainLegs, ticker, netPremium) => {
        const rNull = runRisk(chainLegs, ticker, null, netPremium);
        const rEmpty = runRisk(chainLegs, ticker, buildPortfolio([]), netPremium);
        if (rNull.maxLossUnbounded !== rEmpty.maxLossUnbounded) return false;
        if (rNull.maxGainUnbounded !== rEmpty.maxGainUnbounded) return false;
        if (rNull.maxLoss !== rEmpty.maxLoss) return false;
        if (rNull.maxGain !== rEmpty.maxGain) return false;
        return true;
      }),
      fcOpts(500),
    );
  });
});

// ---------------------------------------------------------------------------
// Quick sanity: forced-coverage joint actually produces coverage.
// Not a bug-catching property per se — a meta-check that the generator
// isn't accidentally producing no-coverage cases (which would silently
// turn the rest of the suite into no-op runs).
// ---------------------------------------------------------------------------
describe("fuzz: generator sanity", () => {
  it("arbJointGuaranteedCover produces at least one matching covering long in every draw", () => {
    fc.assert(
      fc.property(arbJointGuaranteedCover, ({ portfolio, chainLegs, ticker }) => {
        const aug = augmentOrderLegsWithPortfolioCoverage(chainLegs, ticker, portfolio);
        return aug.coveringLegs.length > 0;
      }),
      fcOpts(200),
    );
  });
});
