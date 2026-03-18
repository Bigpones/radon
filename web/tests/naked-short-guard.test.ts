/**
 * Unit tests: Naked short guard — blocks naked short exposure.
 *
 * Validates that checkNakedShortRisk blocks selling stock/calls
 * without sufficient long coverage, while allowing spreads, puts,
 * and buy orders.
 */

import { describe, it, expect } from "vitest";
import {
  checkNakedShortRisk,
  auditOpenOrders,
  type OrderPayload,
  type NakedShortPortfolio,
  type NakedShortOpenOrder,
} from "../lib/nakedShortGuard";

/* ---------- helpers ---------- */

function makePortfolio(positions: NakedShortPortfolio["positions"] = []): NakedShortPortfolio {
  return { positions };
}

function makeOrder(overrides: Partial<OrderPayload>): OrderPayload {
  return {
    type: "stock",
    symbol: "AAPL",
    action: "BUY",
    quantity: 100,
    limitPrice: 250,
    ...overrides,
  };
}

/* ---------- positions ---------- */

const longStock = (ticker: string, shares: number) => ({
  ticker,
  structure_type: "Stock",
  contracts: shares,
  direction: "LONG" as const,
  legs: [{ direction: "LONG" as const, type: "Stock" as const, contracts: shares, strike: null }],
});

const coveredCall = (ticker: string, shares: number, callContracts: number) => ({
  ticker,
  structure_type: "Covered Call",
  contracts: callContracts,
  direction: "CREDIT" as const,
  legs: [
    { direction: "LONG" as const, type: "Stock" as const, contracts: shares, strike: null },
    { direction: "SHORT" as const, type: "Call" as const, contracts: callContracts, strike: 300 },
  ],
});

/* ---------- tests ---------- */

describe("checkNakedShortRisk", () => {
  it("1. BUY stock → allowed", () => {
    const order = makeOrder({ action: "BUY", type: "stock", symbol: "AAPL" });
    const result = checkNakedShortRisk(order, makePortfolio());
    expect(result.allowed).toBe(true);
  });

  it("2. BUY call → allowed", () => {
    const order = makeOrder({
      action: "BUY",
      type: "option",
      symbol: "AAPL",
      right: "C",
      strike: 300,
      expiry: "2026-04-17",
      quantity: 10,
    });
    const result = checkNakedShortRisk(order, makePortfolio());
    expect(result.allowed).toBe(true);
  });

  it("3. SELL stock, no position → blocked (naked short stock)", () => {
    const order = makeOrder({ action: "SELL", type: "stock", symbol: "AAPL", quantity: 100 });
    const result = checkNakedShortRisk(order, makePortfolio());
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("no long shares held");
    expect(result.reason).toContain("AAPL");
  });

  it("4. SELL stock, has position, qty ≤ held → allowed", () => {
    const order = makeOrder({ action: "SELL", type: "stock", symbol: "AAPL", quantity: 50 });
    const portfolio = makePortfolio([longStock("AAPL", 100)]);
    const result = checkNakedShortRisk(order, portfolio);
    expect(result.allowed).toBe(true);
  });

  it("5. SELL stock, has position, qty > held → blocked", () => {
    const order = makeOrder({ action: "SELL", type: "stock", symbol: "AAPL", quantity: 200 });
    const portfolio = makePortfolio([longStock("AAPL", 100)]);
    const result = checkNakedShortRisk(order, portfolio);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("selling 200 shares but only 100 held");
  });

  it("6. SELL call, no stock position → blocked (naked short call)", () => {
    const order = makeOrder({
      action: "SELL",
      type: "option",
      symbol: "AAPL",
      right: "C",
      strike: 300,
      expiry: "2026-04-17",
      quantity: 5,
    });
    const result = checkNakedShortRisk(order, makePortfolio());
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Naked short call");
    expect(result.reason).toContain("AAPL");
  });

  it("7. SELL call, has stock, contracts * 100 ≤ shares → allowed (covered call)", () => {
    const order = makeOrder({
      action: "SELL",
      type: "option",
      symbol: "AAPL",
      right: "C",
      strike: 300,
      expiry: "2026-04-17",
      quantity: 1,
    });
    const portfolio = makePortfolio([longStock("AAPL", 200)]);
    const result = checkNakedShortRisk(order, portfolio);
    expect(result.allowed).toBe(true);
  });

  it("8. SELL call, has stock, contracts * 100 > shares → blocked (short a tail)", () => {
    const order = makeOrder({
      action: "SELL",
      type: "option",
      symbol: "AAPL",
      right: "C",
      strike: 300,
      expiry: "2026-04-17",
      quantity: 5,
    });
    const portfolio = makePortfolio([longStock("AAPL", 200)]);
    const result = checkNakedShortRisk(order, portfolio);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Short a tail");
    expect(result.reason).toContain("5 calls");
    expect(result.reason).toContain("200 shares cover 2 contracts");
  });

  it("9. SELL put → allowed (cash-secured)", () => {
    const order = makeOrder({
      action: "SELL",
      type: "option",
      symbol: "AAPL",
      right: "P",
      strike: 200,
      expiry: "2026-04-17",
      quantity: 10,
    });
    const result = checkNakedShortRisk(order, makePortfolio());
    expect(result.allowed).toBe(true);
  });

  it("10. Combo order with BUY+SELL legs → allowed (spread)", () => {
    const order: OrderPayload = {
      type: "combo",
      symbol: "AAPL",
      action: "BUY",
      quantity: 10,
      limitPrice: 2.5,
      legs: [
        { expiry: "2026-04-17", strike: 270, right: "C", action: "BUY", ratio: 1 },
        { expiry: "2026-04-17", strike: 290, right: "C", action: "SELL", ratio: 1 },
      ],
    };
    const result = checkNakedShortRisk(order, makePortfolio());
    expect(result.allowed).toBe(true);
  });

  it("10b. SELL call covered by existing covered-call stock leg → allowed", () => {
    const order = makeOrder({
      action: "SELL",
      type: "option",
      symbol: "AAPL",
      right: "C",
      strike: 310,
      expiry: "2026-05-15",
      quantity: 1,
    });
    // 300 shares from covered call, 2 already sold → 1 remaining cover
    const portfolio = makePortfolio([coveredCall("AAPL", 300, 2)]);
    const result = checkNakedShortRisk(order, portfolio);
    expect(result.allowed).toBe(true);
  });
});

describe("auditOpenOrders", () => {
  it("11. open SELL call order with no stock → returns violation", () => {
    const orders: NakedShortOpenOrder[] = [
      {
        orderId: 1,
        permId: 100,
        symbol: "TSLA",
        action: "SELL",
        totalQuantity: 5,
        contract: { secType: "OPT", right: "C", strike: 300, expiry: "2026-06-20", symbol: "TSLA" },
      },
    ];
    const violations = auditOpenOrders(orders, makePortfolio());
    expect(violations).toHaveLength(1);
    expect(violations[0].orderId).toBe(1);
    expect(violations[0].permId).toBe(100);
    expect(violations[0].reason).toContain("TSLA");
  });

  it("12. open SELL call order with sufficient stock → returns empty", () => {
    const orders: NakedShortOpenOrder[] = [
      {
        orderId: 2,
        permId: 200,
        symbol: "AAPL",
        action: "SELL",
        totalQuantity: 1,
        contract: { secType: "OPT", right: "C", strike: 300, expiry: "2026-06-20", symbol: "AAPL" },
      },
    ];
    const portfolio = makePortfolio([longStock("AAPL", 500)]);
    const violations = auditOpenOrders(orders, portfolio);
    expect(violations).toHaveLength(0);
  });

  it("13. audit accounts for existing short calls in portfolio", () => {
    // Portfolio already has 2 short call contracts (covered call) using 200 of 300 shares
    // Open order wants to sell 2 more calls = total 4 contracts = 400 shares needed, only 300 held
    const orders: NakedShortOpenOrder[] = [
      {
        orderId: 3,
        permId: 300,
        symbol: "AAPL",
        action: "SELL",
        totalQuantity: 2,
        contract: { secType: "OPT", right: "C", strike: 310, expiry: "2026-06-20", symbol: "AAPL" },
      },
    ];
    const portfolio = makePortfolio([coveredCall("AAPL", 300, 2)]);
    const violations = auditOpenOrders(orders, portfolio);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toContain("AAPL");
  });
});
