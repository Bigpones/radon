"use client";

import { classifyTicks } from "@/lib/book/depthDerivations";
import type { Trade } from "@/lib/pricesProtocol";
import { fmtDepthPrice } from "./depthFormat";

/**
 * Time & Sales tape. Each row is tick-tested (up / down / flat relative to the
 * prior print) by the pure `classifyTicks` helper; this component is a thin
 * presentation shell. `visible` drives the reflow-aware opacity on the parent.
 */
export function TimeAndSales({ trades, visible }: { trades: Trade[]; visible: boolean }) {
  const rows = classifyTicks(trades);

  return (
    <div className={`book-tape${visible ? "" : " book-tape-hidden"}`}>
      <div className="book-colhead">
        <span>Price</span>
        <span className="r">Shares</span>
        <span className="r">Mkt</span>
        <span className="r">Time</span>
      </div>
      <div>
        {rows.map((trade, i) => (
          <div
            className="book-trow book-reveal"
            style={{ ["--i" as string]: i }}
            key={`${trade.time}-${i}`}
          >
            <span className={`book-t-px ${trade.tone}`}>{fmtDepthPrice(trade.price)}</span>
            <span className="book-t-sz">{trade.size}</span>
            <span className="book-t-mkt">{trade.exchange ?? "--"}</span>
            <span className="book-t-time">{trade.time}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
