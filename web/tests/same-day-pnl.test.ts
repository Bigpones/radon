import { describe, it, expect } from "vitest";
import { optionKey } from "../lib/pricesProtocol";
import type { PriceData } from "../lib/pricesProtocol";
import type { PortfolioPosition } from "../lib/types";
import { getOptionDailyChg, getTodayPnlDollars } from "../lib/positionUtils";

function makePriceData(overrides: Partial<PriceData> = {}): PriceData {
  return {
    symbol: "TEST", last: null, lastIsCalculated: false,
    bid: null, ask: null, bidSize: null, askSize: null,
    volume: null, high: null, low: null, open: null, close: null,
    delta: null, gamma: null, theta: null, vega: null, impliedVol: null, undPrice: null,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function todayET(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// BTU Long Put $40 — opened TODAY
// avg_entry = $2.80, last = $3.10, yesterday close = $5.17
// Total P&L = (3.10 - 2.80) * 100 * 100 = +$3,000
// Wrong Today's P&L (close-based) = (3.10 - 5.17) * 100 * 100 = -$20,700
// Correct Today's P&L for same-day = +$3,000 (same as Total P&L)
const btuPut: PortfolioPosition = {
  id: 7,
  ticker: "BTU",
  structure: "Long Put $40",
  structure_type: "Option",
  risk_profile: "defined",
  expiry: "2026-04-17",
  contracts: 100,
  direction: "LONG",
  entry_cost: 28000, // 2.80 * 100 * 100
  max_risk: 28000,
  market_value: 31000,
  ib_daily_pnl: null, // IB didn't provide
  kelly_optimal: null,
  target: null,
  stop: null,
  entry_date: todayET(), // opened today
  legs: [{
    direction: "LONG" as const,
    contracts: 100,
    type: "Put" as const,
    strike: 40,
    entry_cost: 28000,
    avg_cost: 28000,
    market_price: 3.10,
    market_value: 31000,
  }],
};

const btuKey = optionKey({ symbol: "BTU", expiry: "20260417", strike: 40, right: "P" });

const btuPrices: Record<string, PriceData> = {
  [btuKey]: makePriceData({ symbol: btuKey, last: 3.10, close: 5.17 }),
};

// Overnight position for comparison — opened 5 days ago
const overnightPos: PortfolioPosition = {
  ...btuPut,
  id: 8,
  entry_date: "2026-03-14",
};

describe("Same-day position — Today's P&L ($)", () => {
  it("same-day position: Today's P&L equals Total P&L when ib_daily_pnl is null", () => {
    const todayPnl = getTodayPnlDollars(btuPut, btuPrices);
    // Total P&L = market_value - entry_cost = 31000 - 28000 = +3000
    // For same-day, Today P&L must equal Total P&L (not close-based -$20,700)
    expect(todayPnl).not.toBeNull();
    expect(todayPnl).toBeCloseTo(3000, 0);
  });

  it("same-day position: prefers ib_daily_pnl when available", () => {
    const posWithIbPnl = { ...btuPut, ib_daily_pnl: 2500 };
    const todayPnl = getTodayPnlDollars(posWithIbPnl, btuPrices);
    expect(todayPnl).toBe(2500);
  });

  it("overnight position: uses close-based fallback (existing behavior)", () => {
    const todayPnl = getTodayPnlDollars(overnightPos, btuPrices);
    // (3.10 - 5.17) * 100 * 100 = -$20,700 — correct for overnight
    expect(todayPnl).not.toBeNull();
    expect(todayPnl).toBeCloseTo(-20700, 0);
  });
});

describe("Same-day position — Day Change %", () => {
  it("same-day position: daily chg uses entry cost as denominator, not close", () => {
    const chg = getOptionDailyChg(btuPut, btuPrices);
    expect(chg).not.toBeNull();
    // Total P&L = +3000, entry_cost = 28000
    // Same-day daily chg = +3000 / 28000 * 100 = +10.71%
    // NOT -40.04% from close-based calculation
    expect(chg!).toBeGreaterThan(0); // must be positive (price went up from entry)
    expect(Math.abs(chg!)).toBeLessThan(20); // reasonable daily chg
  });

  it("overnight position: uses close-based % (existing behavior)", () => {
    const chg = getOptionDailyChg(overnightPos, btuPrices);
    expect(chg).not.toBeNull();
    // (3.10 - 5.17) * 100 * 100 = -$20,700 / |5.17 * 100 * 100| = -40.04%
    expect(chg!).toBeCloseTo(-40.04, 0);
  });
});
