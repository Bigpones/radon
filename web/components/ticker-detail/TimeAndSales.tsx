"use client";

import { classifyTicks } from "@/lib/book/depthDerivations";
import type { Trade } from "@/lib/pricesProtocol";
import { fmtDepthPrice } from "./depthFormat";

/**
 * Render the tape `time` as HH:MM:SS ET. Accepts either an ISO-8601 string
 * (what the relay emits) or a unix-seconds string. Falls through to the raw
 * value if it parses to neither.
 */
function fmtTapeTime(time: string): string {
  const ms = /^\d+$/.test(time.trim()) ? Number(time) * 1000 : Date.parse(time);
  if (!Number.isFinite(ms) || ms <= 0) return time;
  return new Date(ms).toLocaleTimeString("en-US", {
    hour12: false,
    timeZone: "America/New_York",
  });
}

/**
 * Time & Sales tape. `trades` arrives OLDEST-first (the relay's ring-buffer
 * order); classifyTicks must see it that way so each print is tick-tested
 * against the chronologically prior one. We then reverse so the NEWEST print
 * renders at the top, the montage-tape convention.
 * `visible` drives the reflow-aware opacity on the parent.
 */
export function TimeAndSales({ trades, visible }: { trades: Trade[]; visible: boolean }) {
  const rows = classifyTicks(trades).reverse();

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
            <span className="book-t-time">{fmtTapeTime(trade.time)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
