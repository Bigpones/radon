import { describe, expect, it } from "vitest";

import type { DepthLevel, Trade } from "@/lib/pricesProtocol";
import {
  buildLadderRows,
  classifyTicks,
  groupPriceLevels,
  isBestLevel,
  montageFill,
} from "@/lib/book/depthDerivations";

/* ─── Fixtures (fixed literals only — no wall clock, no RNG) ─── */

const STOCK_BID: DepthLevel[] = [
  { price: 152.52, size: 34, marketMaker: "XNMS", exchange: "SMART" },
  { price: 152.52, size: 100, marketMaker: "IEXG", exchange: "SMART" },
  { price: 152.51, size: 100, marketMaker: "XNYS", exchange: "SMART" },
  { price: 152.48, size: 26, marketMaker: "XNMS", exchange: "SMART" },
];

const STOCK_ASK: DepthLevel[] = [
  { price: 152.70, size: 738, marketMaker: "XNMS", exchange: "SMART" },
  { price: 152.70, size: 100, marketMaker: "BATY", exchange: "SMART" },
  { price: 152.75, size: 10, marketMaker: "XNMS", exchange: "SMART" },
];

const FUTURES_BID: DepthLevel[] = [
  { price: 5012.50, size: 137, marketMaker: null, exchange: null },
  { price: 5012.25, size: 295, marketMaker: null, exchange: null },
  { price: 5012.00, size: 263, marketMaker: null, exchange: null },
];

const FUTURES_ASK: DepthLevel[] = [
  { price: 5012.75, size: 142, marketMaker: null, exchange: null },
  { price: 5013.00, size: 318, marketMaker: null, exchange: null },
  { price: 5013.25, size: 274, marketMaker: null, exchange: null },
];

const TAPE: Trade[] = [
  { price: 152.70, size: 1, exchange: "FINY", time: "12:10:29" },
  { price: 152.66, size: 4, exchange: "FINY", time: "12:10:28" },
  { price: 152.66, size: 36, exchange: "FINY", time: "12:10:27" },
  { price: 152.73, size: 5, exchange: "XNYS", time: "12:10:26" },
];

describe("groupPriceLevels", () => {
  it("marks the first row of each distinct price (montage edge marker)", () => {
    const grouped = groupPriceLevels(STOCK_BID);
    expect(grouped.map((r) => r.firstOfLevel)).toEqual([true, false, true, true]);
  });

  it("marks the very first row as the start of a level", () => {
    const grouped = groupPriceLevels(STOCK_ASK);
    expect(grouped[0].firstOfLevel).toBe(true);
  });

  it("treats adjacent (close but unequal) prices as separate levels", () => {
    const adjacent: DepthLevel[] = [
      { price: 10.01, size: 5, marketMaker: null, exchange: null },
      { price: 10.0, size: 5, marketMaker: null, exchange: null },
    ];
    expect(groupPriceLevels(adjacent).map((r) => r.firstOfLevel)).toEqual([
      true,
      true,
    ]);
  });

  it("conserves size: grouped size sum equals raw size sum", () => {
    const rawSum = STOCK_BID.reduce((acc, r) => acc + r.size, 0);
    const groupedSum = groupPriceLevels(STOCK_BID).reduce(
      (acc, r) => acc + r.size,
      0,
    );
    expect(groupedSum).toBe(rawSum);
  });

  it("returns an empty array for an empty side", () => {
    expect(groupPriceLevels([])).toEqual([]);
  });
});

describe("montageFill", () => {
  it("returns intensity in [0,1]", () => {
    for (const level of [...STOCK_BID, ...STOCK_ASK]) {
      const fill = montageFill(level, 738);
      expect(fill).toBeGreaterThanOrEqual(0);
      expect(fill).toBeLessThanOrEqual(1);
    }
  });

  it("returns 1 for the largest level", () => {
    expect(montageFill({ price: 1, size: 738, marketMaker: null, exchange: null }, 738)).toBe(1);
  });

  it("returns 0 when maxSize is non-positive (no divide by zero)", () => {
    expect(montageFill(STOCK_BID[0], 0)).toBe(0);
    expect(montageFill(STOCK_BID[0], -5)).toBe(0);
  });
});

describe("buildLadderRows", () => {
  it("accrues cumulative size monotonically from the inside out", () => {
    const { bidRows, askRows } = buildLadderRows({
      bid: FUTURES_BID,
      ask: FUTURES_ASK,
    });
    // bidRows are inside -> worst, so cum is non-decreasing in order.
    const bidCums = bidRows.map((r) => r.cum);
    expect(bidCums).toEqual([137, 137 + 295, 137 + 295 + 263]);
    for (let i = 1; i < bidCums.length; i++) {
      expect(bidCums[i]).toBeGreaterThanOrEqual(bidCums[i - 1]);
    }
    // askRows are emitted worst -> best (reversed), so cum is non-increasing.
    const askCums = askRows.map((r) => r.cum);
    expect(askCums).toEqual([142 + 318 + 274, 142 + 318, 142]);
    for (let i = 1; i < askCums.length; i++) {
      expect(askCums[i]).toBeLessThanOrEqual(askCums[i - 1]);
    }
  });

  it("emits asks worst->best (top) and bids best->worst (spine down)", () => {
    const { bidRows, askRows } = buildLadderRows({
      bid: FUTURES_BID,
      ask: FUTURES_ASK,
    });
    expect(askRows[0].level.price).toBe(5013.25); // worst ask at top
    expect(askRows[askRows.length - 1].level.price).toBe(5012.75); // best ask above spine
    expect(bidRows[0].level.price).toBe(5012.50); // best bid below spine
    expect(bidRows[bidRows.length - 1].level.price).toBe(5012.00); // worst bid
  });

  it("scales fill into [0,1] against the deepest cumulative", () => {
    const result = buildLadderRows({ bid: FUTURES_BID, ask: FUTURES_ASK });
    const allRows = [...result.askRows, ...result.bidRows];
    for (const row of allRows) {
      expect(row.fill).toBeGreaterThanOrEqual(0);
      expect(row.fill).toBeLessThanOrEqual(1);
      expect(row.fill).toBeCloseTo(row.cum / result.maxCumulative, 10);
    }
    expect(Math.max(...allRows.map((r) => r.fill))).toBeCloseTo(1, 10);
  });

  it("flags the inside row of each side as best", () => {
    const { bidRows, askRows } = buildLadderRows({
      bid: FUTURES_BID,
      ask: FUTURES_ASK,
    });
    // best bid sits at the spine (last emitted is worst, first is best)
    expect(bidRows.find((r) => r.isBest)?.level.price).toBe(5012.50);
    // best ask sits just above the spine (last emitted after reverse)
    expect(askRows.find((r) => r.isBest)?.level.price).toBe(5012.75);
    expect(bidRows.filter((r) => r.isBest)).toHaveLength(1);
    expect(askRows.filter((r) => r.isBest)).toHaveLength(1);
  });

  it("maxCumulative is the largest cumulative across both sides", () => {
    const { maxCumulative } = buildLadderRows({
      bid: FUTURES_BID,
      ask: FUTURES_ASK,
    });
    expect(maxCumulative).toBe(142 + 318 + 274); // 734, the deeper (ask) side
  });

  it("handles an empty book without dividing by zero", () => {
    const { askRows, bidRows, maxCumulative } = buildLadderRows({
      bid: [],
      ask: [],
    });
    expect(askRows).toEqual([]);
    expect(bidRows).toEqual([]);
    expect(maxCumulative).toBe(1);
  });

  it("handles a one-sided book (bids only)", () => {
    const { askRows, bidRows, maxCumulative } = buildLadderRows({
      bid: FUTURES_BID,
      ask: [],
    });
    expect(askRows).toEqual([]);
    expect(bidRows).toHaveLength(FUTURES_BID.length);
    expect(maxCumulative).toBe(695);
    expect(bidRows[0].fill).toBeGreaterThan(0);
  });
});

describe("classifyTicks", () => {
  it("applies the tick test up/down/flat against the prior price", () => {
    const tones = classifyTicks(TAPE).map((t) => t.tone);
    expect(tones).toEqual(["flat", "down", "flat", "up"]);
  });

  it("classifies the first trade as flat (no predecessor)", () => {
    expect(classifyTicks(TAPE)[0].tone).toBe("flat");
  });

  it("preserves the original trade fields", () => {
    const [first] = classifyTicks(TAPE);
    expect(first.price).toBe(152.70);
    expect(first.size).toBe(1);
    expect(first.exchange).toBe("FINY");
    expect(first.time).toBe("12:10:29");
  });

  it("returns an empty array for an empty tape", () => {
    expect(classifyTicks([])).toEqual([]);
  });
});

describe("isBestLevel", () => {
  it("treats index 0 as best for stocks", () => {
    expect(isBestLevel(STOCK_BID[0], 0, "stock")).toBe(true);
    expect(isBestLevel(STOCK_BID[1], 1, "stock")).toBe(false);
  });

  it("treats index 0 as best for futures", () => {
    expect(isBestLevel(FUTURES_BID[0], 0, "future")).toBe(true);
    expect(isBestLevel(FUTURES_BID[2], 2, "future")).toBe(false);
  });

  it("uses the nbbo flag (not index) for options", () => {
    const nbboRow = { ...STOCK_BID[2], nbbo: true };
    const nonNbboRow = { ...STOCK_BID[0], nbbo: false };
    expect(isBestLevel(nbboRow, 2, "option")).toBe(true);
    expect(isBestLevel(nonNbboRow, 0, "option")).toBe(false);
  });

  it("is false for an option row without an nbbo flag", () => {
    expect(isBestLevel(STOCK_BID[0], 0, "option")).toBe(false);
  });
});
