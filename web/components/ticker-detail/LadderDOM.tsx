"use client";

import { buildLadderRows, type LadderRow } from "@/lib/book/depthDerivations";
import type { DepthBook } from "@/lib/pricesProtocol";
import type { OrderPrefill } from "@/lib/TickerDetailContext";
import { fmtDepthPrice } from "./depthFormat";

type PriceClick = (p: Omit<OrderPrefill, "nonce">) => void;

/**
 * Futures centered ladder DOM: bid size (left) | price spine | ask size
 * (right). Cumulative-depth bars fan out from the spine so resting walls read
 * at a glance. Row ordering + cumulative + fill come from the pure
 * `buildLadderRows` helper; asks are emitted worst -> best down to the spread
 * divider, bids best -> worst below it.
 */
export function LadderDOM({
  book,
  last,
  onPriceClick,
}: {
  book: DepthBook;
  last: number | null;
  onPriceClick?: PriceClick;
}) {
  const { askRows, bidRows } = buildLadderRows({ bid: book.bid, ask: book.ask });
  const insideBid = book.bid[0]?.price ?? null;
  const insideAsk = book.ask[0]?.price ?? null;
  const spread =
    insideBid != null && insideAsk != null ? (insideAsk - insideBid).toFixed(2) : "---";

  // Click-to-fill: an ASK ladder row -> BUY (lift the offer); a BID row -> SELL
  // (hit the bid). The center spread/LAST spine is not a tradeable level.
  const clickProps = (side: "bid" | "ask", price: number) => {
    if (!onPriceClick) return {};
    const action = side === "ask" ? "BUY" : "SELL";
    return {
      role: "button" as const,
      tabIndex: 0,
      "aria-label": `Fill ticket: ${action} ${fmtDepthPrice(price)}`,
      title: `Fill ticket: ${action} ${fmtDepthPrice(price)}`,
      onClick: () => onPriceClick({ price, action, source: "ladder" as const }),
    };
  };

  const askRow = (row: LadderRow, i: number) => (
    <div
      className={`book-lrow ask book-reveal${row.isBest ? " best" : ""}${onPriceClick ? " book-row-fill" : ""}`}
      style={{ ["--fill" as string]: Math.round(row.fill * 95), ["--i" as string]: i }}
      key={`ask-${i}`}
      {...clickProps("ask", row.level.price)}
    >
      <span className="book-lsz" />
      <span className="book-lpx">{fmtDepthPrice(row.level.price)}</span>
      <span className="book-rsz">{row.level.size}</span>
    </div>
  );

  const bidRow = (row: LadderRow, i: number) => (
    <div
      className={`book-lrow bid book-reveal${row.isBest ? " best" : ""}${onPriceClick ? " book-row-fill" : ""}`}
      style={{ ["--fill" as string]: Math.round(row.fill * 95), ["--i" as string]: i }}
      key={`bid-${i}`}
      {...clickProps("bid", row.level.price)}
    >
      <span className="book-lsz">{row.level.size}</span>
      <span className="book-lpx">{fmtDepthPrice(row.level.price)}</span>
      <span className="book-rsz" />
    </div>
  );

  return (
    <div className="book-ladder">
      <div className="book-ladder-head">
        <span className="l">Bid Size</span>
        <span className="c">Price</span>
        <span className="rr">Ask Size</span>
      </div>
      {askRows.map(askRow)}
      <div className="book-ladder-spread">
        <span>
          LAST <b>{last != null ? fmtDepthPrice(last) : "---"}</b>
        </span>
        <span>
          SPRD <b>{spread}</b>
        </span>
      </div>
      {bidRows.map(bidRow)}
    </div>
  );
}
