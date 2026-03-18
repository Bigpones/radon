/**
 * Naked short guard — prevents orders that would create naked short exposure.
 *
 * Rules:
 * - SELL stock without sufficient long shares → BLOCK
 * - SELL call without sufficient long shares to cover → BLOCK
 * - SELL put → ALLOW (cash-secured, defined risk)
 * - Combo/spread with both BUY+SELL legs → ALLOW (covered by long leg)
 * - BUY anything → ALLOW
 */

/* ---------- types ---------- */

export type OrderPayload = {
  type: "stock" | "option" | "combo";
  symbol: string;
  action: "BUY" | "SELL";
  quantity: number;
  limitPrice: number;
  expiry?: string;
  strike?: number;
  right?: "C" | "P";
  legs?: {
    expiry: string;
    strike: number;
    right: "C" | "P";
    action: "BUY" | "SELL";
    ratio: number;
  }[];
};

export type NakedShortPortfolioPosition = {
  ticker: string;
  structure_type: string;
  contracts: number;
  direction: string;
  legs: {
    direction: "LONG" | "SHORT";
    type: "Call" | "Put" | "Stock";
    contracts: number;
    strike: number | null;
  }[];
};

export type NakedShortPortfolio = {
  positions: NakedShortPortfolioPosition[];
};

export type NakedShortOpenOrder = {
  orderId: number;
  permId: number;
  symbol: string;
  action: string;
  totalQuantity: number;
  contract: {
    secType: string;
    right: string | null;
    strike: number | null;
    expiry: string | null;
    symbol: string;
  };
};

export type GuardResult = { allowed: boolean; reason?: string };

/* ---------- helpers ---------- */

/** Count long stock shares for a ticker across all positions. */
function countLongShares(ticker: string, portfolio: NakedShortPortfolio): number {
  let shares = 0;
  for (const pos of portfolio.positions) {
    if (pos.ticker !== ticker) continue;
    for (const leg of pos.legs) {
      if (leg.type === "Stock" && leg.direction === "LONG") {
        shares += leg.contracts;
      }
    }
  }
  return shares;
}

/** Count existing short call contracts for a ticker across all positions. */
function countExistingShortCalls(ticker: string, portfolio: NakedShortPortfolio): number {
  let contracts = 0;
  for (const pos of portfolio.positions) {
    if (pos.ticker !== ticker) continue;
    for (const leg of pos.legs) {
      if (leg.type === "Call" && leg.direction === "SHORT") {
        contracts += leg.contracts;
      }
    }
  }
  return contracts;
}

/* ---------- main guard ---------- */

export function checkNakedShortRisk(
  order: OrderPayload,
  portfolio: NakedShortPortfolio,
): GuardResult {
  // BUY anything → always allowed
  if (order.action === "BUY") {
    return { allowed: true };
  }

  // Combo/spread with both BUY and SELL legs → covered by long leg
  if (order.type === "combo" && order.legs && order.legs.length >= 2) {
    const hasBuy = order.legs.some((l) => l.action === "BUY");
    const hasSell = order.legs.some((l) => l.action === "SELL");
    if (hasBuy && hasSell) {
      return { allowed: true };
    }
  }

  const sym = order.symbol;

  // SELL stock
  if (order.type === "stock") {
    const held = countLongShares(sym, portfolio);
    if (held === 0) {
      return {
        allowed: false,
        reason: `Naked short stock: no long shares held for ${sym}`,
      };
    }
    if (order.quantity > held) {
      return {
        allowed: false,
        reason: `Naked short stock: selling ${order.quantity} shares but only ${held} held for ${sym}`,
      };
    }
    return { allowed: true };
  }

  // SELL option
  if (order.type === "option") {
    // SELL put → cash-secured, always allowed
    if (order.right === "P") {
      return { allowed: true };
    }

    // SELL call → need long shares to cover
    if (order.right === "C") {
      const shares = countLongShares(sym, portfolio);
      if (shares === 0) {
        return {
          allowed: false,
          reason: `Naked short call: no long shares held to cover ${sym} calls`,
        };
      }

      const existingShortCalls = countExistingShortCalls(sym, portfolio);
      const totalShortContracts = existingShortCalls + order.quantity;
      const coveredContracts = Math.floor(shares / 100);

      if (totalShortContracts > coveredContracts) {
        return {
          allowed: false,
          reason: `Short a tail: selling ${order.quantity} calls but only ${shares} shares cover ${coveredContracts} contracts for ${sym}`,
        };
      }
      return { allowed: true };
    }
  }

  return { allowed: true };
}

/* ---------- audit open orders ---------- */

export function auditOpenOrders(
  orders: NakedShortOpenOrder[],
  portfolio: NakedShortPortfolio,
): { orderId: number; permId: number; reason: string }[] {
  const violations: { orderId: number; permId: number; reason: string }[] = [];

  for (const order of orders) {
    // Only audit SELL call orders
    if (order.action !== "SELL") continue;
    if (order.contract.secType !== "OPT" || order.contract.right !== "C") continue;

    const sym = order.symbol;
    const shares = countLongShares(sym, portfolio);

    if (shares === 0) {
      violations.push({
        orderId: order.orderId,
        permId: order.permId,
        reason: `Naked short call: no long shares held to cover ${sym} calls`,
      });
      continue;
    }

    const existingShortCalls = countExistingShortCalls(sym, portfolio);
    const coveredContracts = Math.floor(shares / 100);

    if (existingShortCalls + order.totalQuantity > coveredContracts) {
      violations.push({
        orderId: order.orderId,
        permId: order.permId,
        reason: `Short a tail: selling ${order.totalQuantity} calls but only ${shares} shares cover ${coveredContracts} contracts for ${sym} (${existingShortCalls} already short)`,
      });
    }
  }

  return violations;
}
