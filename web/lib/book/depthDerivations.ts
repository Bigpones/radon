import type { DepthBook, DepthLevel, Trade } from "@/lib/pricesProtocol";

/**
 * Pure, side-effect-free derivations for the L2 order book.
 *
 * These mirror the render math in the montage mockup 1:1 so the component layer
 * stays a thin presentation shell. Everything here is deterministic: same input,
 * same output, no clocks, no globals. Tested in isolation under Node.
 */

/**
 * Mark the first row of each distinct price so the montage can draw the
 * per-price-level edge marker. Input is already ordered best -> worst, so a
 * level boundary is simply a price that differs from the row above it. The
 * very first row always starts a level.
 */
export function groupPriceLevels(
  rows: DepthLevel[],
): Array<DepthLevel & { firstOfLevel: boolean }> {
  let previousPrice: number | null = null;
  return rows.map((row) => {
    const firstOfLevel = row.price !== previousPrice;
    previousPrice = row.price;
    return { ...row, firstOfLevel };
  });
}

/**
 * Per-level intensity in [0,1] for the resting-size depth bar. Scaled against
 * the deepest single level on screen so the busiest row reads as full. A
 * non-positive maxSize means there is nothing to scale against, so every row is
 * empty rather than dividing by zero.
 */
export function montageFill(level: DepthLevel, maxSize: number): number {
  if (maxSize <= 0) return 0;
  return level.size / maxSize;
}

export type LadderRow = {
  level: DepthLevel;
  cum: number;
  fill: number;
  isBest: boolean;
};

export type LadderRows = {
  askRows: LadderRow[];
  bidRows: LadderRow[];
  maxCumulative: number;
};

/**
 * Build the centered futures DOM ladder. Cumulative size accrues from the
 * inside out on each side so a resting wall shows as a long bar regardless of
 * how far from the touch it sits. Asks are emitted worst -> best (top of the
 * ladder down to the spine); bids best -> worst (spine down). fill normalises
 * each cumulative against the deepest cumulative across both sides so the bars
 * share one scale.
 */
export function buildLadderRows(book: {
  bid: DepthLevel[];
  ask: DepthLevel[];
}): LadderRows {
  const bidCum = runningCumulative(book.bid);
  const askCum = runningCumulative(book.ask);
  const maxCumulative = Math.max(...bidCum, ...askCum, 1);

  const toRow = (level: DepthLevel, index: number, cum: number): LadderRow => ({
    level,
    cum,
    fill: cum / maxCumulative,
    isBest: index === 0,
  });

  const askRows = book.ask
    .map((level, index) => toRow(level, index, askCum[index]))
    .reverse();
  const bidRows = book.bid.map((level, index) =>
    toRow(level, index, bidCum[index]),
  );

  return { askRows, bidRows, maxCumulative };
}

export type TickTone = "up" | "down" | "flat";

/**
 * Apply the tick test to a Time & Sales tape: each trade is up/down relative to
 * the price immediately before it, flat on an equal price. The first trade has
 * no predecessor and is flat by convention (we never fabricate a prior price).
 */
export function classifyTicks(
  trades: Trade[],
): Array<Trade & { tone: TickTone }> {
  let previousPrice: number | null = null;
  return trades.map((trade) => {
    const tone: TickTone =
      previousPrice == null
        ? "flat"
        : trade.price > previousPrice
          ? "up"
          : trade.price < previousPrice
            ? "down"
            : "flat";
    previousPrice = trade.price;
    return { ...trade, tone };
  });
}

/**
 * Whether a row is the inside (best) quote for its side. Stock and future books
 * are position-ordered, so the inside row is index 0. Option books are a
 * per-exchange BBO montage where the NBBO-setting venues are flagged explicitly,
 * so we trust the nbbo flag instead of position.
 */
export function isBestLevel(
  level: DepthLevel,
  index: number,
  kind: "stock" | "option" | "future",
): boolean {
  if (kind === "option") return level.nbbo === true;
  return index === 0;
}

export type BookHeader = {
  bid: number | null;
  ask: number | null;
  /** Depth-derived mid ((bestBid+bestAsk)/2) — the authoritative "MARK" on the
   *  Book tab when an entitled depth book is present. */
  last: number | null;
  /** "MID" when derived from the book, "LAST"/"MARK" when from the L1 feed. */
  lastLabel: string;
};

/**
 * Best bid (max across the book.bid rows) / best ask (min across book.ask).
 * For options this is the NBBO across venue rows; for stocks index 0 is already
 * the inside, and max/min still resolve it. Returns null on an empty side.
 */
function bestBidPrice(rows: DepthLevel[]): number | null {
  if (rows.length === 0) return null;
  return Math.max(...rows.map((row) => row.price));
}

function bestAskPrice(rows: DepthLevel[]): number | null {
  if (rows.length === 0) return null;
  return Math.min(...rows.map((row) => row.price));
}

/**
 * Resolve the window-head bid / ask / mark for the Book tab.
 *
 * When an entitled depth book is present it is the authoritative source (a
 * corrupt or negative L1 scalar is ignored): bid/ask come from the book itself
 * and the MARK is the depth mid, labelled "MID". Futures key the inside on
 * position (index 0); stocks/options take the best price across the side
 * (NBBO for options, inside for stocks). The relay's `nbbo` summary is
 * preferred for options when present.
 *
 * Falls back entirely to the passed-in L1 scalars when there is no entitled
 * depth book (the L1 fallback path).
 */
export function deriveBookHeader(
  depth: DepthBook | null | undefined,
  l1: { bid: number | null; ask: number | null; last: number | null; lastLabel: string },
): BookHeader {
  if (!depth || depth.entitled !== true) {
    return { bid: l1.bid, ask: l1.ask, last: l1.last, lastLabel: l1.lastLabel };
  }

  let bid: number | null;
  let ask: number | null;
  if (depth.kind === "future") {
    bid = depth.bid[0]?.price ?? null;
    ask = depth.ask[0]?.price ?? null;
  } else if (depth.kind === "option" && depth.nbbo) {
    bid = depth.nbbo.bestBid ?? bestBidPrice(depth.bid);
    ask = depth.nbbo.bestAsk ?? bestAskPrice(depth.ask);
  } else {
    bid = bestBidPrice(depth.bid);
    ask = bestAskPrice(depth.ask);
  }

  const mid =
    depth.kind === "option" && depth.nbbo?.mid != null
      ? depth.nbbo.mid
      : bid != null && ask != null
        ? (bid + ask) / 2
        : null;

  return { bid, ask, last: mid, lastLabel: "MID" };
}

/**
 * Running cumulative size from the inside out. Returned array is parallel to the
 * input: entry i is the sum of sizes 0..i.
 */
function runningCumulative(rows: DepthLevel[]): number[] {
  let sum = 0;
  return rows.map((row) => {
    sum += row.size;
    return sum;
  });
}
