/**
 * fast-check arbitraries for the order-risk fuzz suite.
 *
 * Three principles guide the choices below:
 *
 *   1. **Small, realistic alphabets** for tickers and expiries so portfolio
 *      ↔ order collisions happen >5% of the time. With a 7-ticker, 5-expiry
 *      alphabet plus 8-position portfolios, the probability that a portfolio
 *      contains at least one matching `(ticker, expiry)` for a given order
 *      sits north of 50% — well above the threshold needed to exercise the
 *      coverage paths under random sampling.
 *
 *   2. **Discrete strikes** drawn from a basket that covers the strike-grid
 *      shapes that real Radon orders use. Continuous strike arbitraries
 *      would shrink to bizarre decimals that don't resemble live data and
 *      make counter-examples harder to read.
 *
 *   3. **Joint generators** that explicitly target coverage / no-coverage
 *      regimes. A pure-independent draw of portfolio + order hits coverage
 *      ~3% of the time; we want 40/40/20 (forced cover / forced no cover /
 *      natural) so the seam paths get exercised on every CI run.
 *
 * Shrinking strategy: `fast-check` walks each component independently. The
 * generators below prefer integer ratios + low quantities so a failing
 * counter-example shrinks to "1 contract at strike 100" rather than a
 * 487-contract leg at $187.55 — much easier to paste into an example test.
 */
import fc from "fast-check";
import type { PortfolioData } from "@/lib/types";
import type { ChainOrderLeg } from "@/lib/order/risk";
import { buildPortfolio, dashed, makePos, makeStockPos, ymd } from "./builders";

// Small alphabets → high collision rate (~50% chance of cover per 8-pos portfolio).
export const arbTicker = fc.constantFrom("WULF", "RR", "AAOI", "AAPL", "TSLA", "ABC", "XYZ");
export const arbExpiryCompact = fc.constantFrom(
  "20260320",
  "20260620",
  "20260918",
  "20270115",
  "20270618",
);

// Discrete strikes covering the typical chain shapes Radon orders touch.
export const arbStrike = fc.constantFrom(
  1, 2, 3.5, 5, 10, 15, 17, 19, 25, 31, 50, 90, 100, 110, 150, 200,
);

export const arbContracts = fc.integer({ min: 1, max: 200 });
// Round lots — keeps the per-100-shares-per-call math integer-friendly when
// stock coverage is in play.
export const arbShares = fc
  .integer({ min: 1, max: 1000 })
  .map((n) => n * 100);
export const arbAvgCost = fc.float({
  min: Math.fround(0.05),
  max: Math.fround(500),
  noNaN: true,
  noDefaultInfinity: true,
});
export const arbRight = fc.constantFrom<"C" | "P">("C", "P");
export const arbAction = fc.constantFrom<"BUY" | "SELL">("BUY", "SELL");
/**
 * Signed net premium spanning credits + debits. Used for chain-leg fuzzing
 * where the action is mixed (BUY + SELL in a combo). For single-action
 * joint generators (e.g. forced-SELL coverage joints), use `arbCreditPremium`
 * or `arbDebitPremium` so the sign matches the action — `computeOrderRisk`
 * has subtly different single-leg vs multi-leg float behaviour when the sign
 * contradicts the action (the single-leg branch takes `abs(netPremium)`,
 * the multi-leg branch is sign-aware), and no production surface ever
 * produces such inputs. The fuzz suite mirrors the legitimate input space.
 */
export const arbNetPremium = fc.float({
  min: Math.fround(-50),
  max: Math.fround(50),
  noNaN: true,
  noDefaultInfinity: true,
});

/** Credit premium — negative. Mirrors SELL leg's signed convention. */
export const arbCreditPremium = fc
  .float({
    min: Math.fround(0.05),
    max: Math.fround(50),
    noNaN: true,
    noDefaultInfinity: true,
  })
  .map((p) => -p);

/** Debit premium — positive. Mirrors BUY leg's signed convention. */
export const arbDebitPremium = fc.float({
  min: Math.fround(0.05),
  max: Math.fround(50),
  noNaN: true,
  noDefaultInfinity: true,
});

// One held LONG option position on a chosen (ticker, expiry).
export const arbOptionPos = fc
  .tuple(arbTicker, arbExpiryCompact, arbRight, arbStrike, arbContracts, fc.constantFrom<"LONG" | "SHORT">("LONG", "SHORT"))
  .map(([ticker, expiryC, right, strike, contracts, direction]) =>
    makePos({
      ticker,
      expiry: dashed(expiryC),
      right: right === "C" ? "Call" : "Put",
      strike,
      direction,
      contracts,
    }),
  );

export const arbStockPos = fc
  .tuple(arbTicker, arbShares, arbAvgCost, fc.constantFrom<"LONG" | "SHORT">("LONG", "SHORT"))
  .map(([ticker, shares, avgCost, direction]) =>
    makeStockPos({ ticker, shares, avgCost, direction }),
  );

// 50/50 mix of option + stock positions. Up to 8-position portfolios.
export const arbPortfolio = fc
  .array(fc.oneof(arbOptionPos, arbStockPos), { minLength: 0, maxLength: 8 })
  .map(buildPortfolio);

export const arbChainLeg = fc
  .tuple(arbAction, arbRight, arbStrike, arbExpiryCompact, arbContracts)
  .map<ChainOrderLeg>(([action, right, strike, expiry, quantity]) => ({
    action,
    right,
    strike,
    expiry,
    quantity,
  }));

export const arbChainOrder = fc.array(arbChainLeg, { minLength: 1, maxLength: 4 });

/**
 * Forced-coverage joint generator. Produces a (portfolio, order, ticker)
 * triple where the order contains at least one SELL leg AND the portfolio
 * contains a LONG instrument on the same (ticker, expiry, right) that is
 * sufficient to cover it. Used by the monotonicity test to verify that
 * adding cover never makes the verdict worse.
 */
export const arbJointGuaranteedCover = fc
  .tuple(
    arbTicker,
    arbExpiryCompact,
    arbRight,
    arbStrike, // K_short
    arbStrike, // K_long — different strike OK; same right, same expiry
    arbContracts, // short qty
    fc.integer({ min: 1, max: 5 }), // long qty multiplier (always >= short)
    arbCreditPremium, // SELL → credit (negative)
  )
  .map(([ticker, expiryC, right, kShort, kLong, shortQty, multiplier, netPremium]) => {
    const longContracts = shortQty * multiplier;
    const portfolio = buildPortfolio([
      makePos({
        ticker,
        expiry: dashed(expiryC),
        right: right === "C" ? "Call" : "Put",
        strike: kLong,
        direction: "LONG",
        contracts: longContracts,
      }),
    ]);
    const chainLegs: ChainOrderLeg[] = [
      { action: "SELL", right, strike: kShort, expiry: expiryC, quantity: shortQty },
    ];
    return { portfolio, chainLegs, ticker, netPremium };
  });

/**
 * Forced-no-coverage joint. Portfolio is on a DIFFERENT ticker than the
 * order, guaranteeing zero coverage. Used as the "before" snapshot in the
 * monotonicity property: adding LONG cover to this portfolio must not
 * increase max-loss.
 */
export const arbJointGuaranteedNoCover = fc
  .tuple(arbTicker, arbExpiryCompact, arbChainLeg.filter((l) => l.action === "SELL"), arbCreditPremium)
  .map(([orderTicker, expiryC, sellLeg, netPremium]) => {
    // Put portfolio on a guaranteed-different ticker
    const otherTicker = orderTicker === "WULF" ? "AAPL" : "WULF";
    const portfolio = buildPortfolio([
      makePos({
        ticker: otherTicker,
        expiry: dashed(expiryC),
        right: "Call",
        strike: 100,
        direction: "LONG",
        contracts: 100,
      }),
    ]);
    return {
      portfolio,
      chainLegs: [{ ...sellLeg, expiry: expiryC }] as ChainOrderLeg[],
      ticker: orderTicker,
      netPremium,
    };
  });

/**
 * Stock-coverage joint: N×100 shares on same ticker as a SELL CALL of N
 * contracts. Drives the stock-cover floor invariant.
 */
export const arbJointStockCover = fc
  .tuple(
    arbTicker,
    arbExpiryCompact,
    arbStrike,
    fc.integer({ min: 1, max: 50 }), // N call contracts
    arbAvgCost,
    fc.float({
      min: Math.fround(0.01),
      max: Math.fround(20),
      noNaN: true,
      noDefaultInfinity: true,
    }), // premium per share (always positive; we sign-flip via action below)
  )
  .map(([ticker, expiryC, kShort, shortQty, avgCost, premium]) => {
    const portfolio = buildPortfolio([
      makeStockPos({ ticker, shares: shortQty * 100, avgCost }),
    ]);
    const chainLegs: ChainOrderLeg[] = [
      { action: "SELL", right: "C", strike: kShort, expiry: expiryC, quantity: shortQty },
    ];
    // SELL CALL with stock cover → credit. netPremium is negative.
    return { portfolio, chainLegs, ticker, netPremium: -premium, avgCost, shortQty, premium };
  });
