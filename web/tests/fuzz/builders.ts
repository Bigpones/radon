/**
 * Shared portfolio + order builders for the fuzz suite. Same shape as the
 * helpers in `web/tests/order-risk.test.ts` — duplicated here intentionally
 * so the fuzz suite is self-contained and doesn't reach back into the
 * example-based tests' private fixtures (which could drift).
 *
 * Why these exist as builders (not arbitraries directly):
 *   1. fast-check generators stay terse — they describe SHAPE (random
 *      strikes, expiries, etc.) and call a builder to materialise the
 *      `PortfolioData.positions[number]` literal.
 *   2. Counter-examples shrink to readable objects: `makePos({strike: 17,
 *      contracts: 77, ...})` reads cleaner than a 50-line literal in a
 *      failure log.
 *   3. The mapping from "user-facing concept" (long $17 call, 100 shares
 *      RR @ $4.43) to the actual `PortfolioLeg` shape lives in one place,
 *      so an upstream `PortfolioLeg` schema change updates the fuzz
 *      universe by editing one file.
 */
import type { PortfolioData } from "@/lib/types";

type Position = PortfolioData["positions"][number];

export function buildPortfolio(positions: Position[]): PortfolioData {
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

export function makePos(opts: {
  ticker: string;
  expiry: string;
  right: "Call" | "Put";
  strike: number;
  direction: "LONG" | "SHORT";
  contracts: number;
}): Position {
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
  } as unknown as Position;
}

export function makeStockPos(opts: {
  ticker: string;
  shares: number;
  avgCost: number;
  direction?: "LONG" | "SHORT";
}): Position {
  return {
    id: Math.floor(Math.random() * 10_000),
    ticker: opts.ticker,
    structure: `${opts.direction ?? "LONG"} Stock`,
    structure_type: "Stock",
    risk_profile: "equity",
    expiry: "",
    contracts: opts.shares,
    direction: opts.direction ?? "LONG",
    entry_cost: opts.shares * opts.avgCost,
    max_risk: null,
    market_value: null,
    legs: [
      {
        direction: opts.direction ?? "LONG",
        contracts: opts.shares,
        type: "Stock",
        strike: null,
        entry_cost: opts.shares * opts.avgCost,
        avg_cost: opts.avgCost,
        market_price: null,
        market_value: null,
      },
    ],
    kelly_optimal: null,
    target: null,
    stop: null,
  } as unknown as Position;
}

/**
 * Normalise "YYYY-MM-DD" → "YYYYMMDD". Chain leg `expiry` uses YYYYMMDD;
 * portfolio `pos.expiry` uses YYYY-MM-DD. The fuzz suite emits one shape
 * and converts at the boundary.
 */
export function ymd(dashedOrCompact: string): string {
  return dashedOrCompact.replace(/-/g, "");
}

/**
 * Inverse: "YYYYMMDD" → "YYYY-MM-DD".
 */
export function dashed(compact: string): string {
  if (compact.length !== 8) return compact;
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}
