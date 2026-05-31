"use client";

import { groupPriceLevels, montageFill, isBestLevel } from "@/lib/book/depthDerivations";
import type { DepthBook, DepthLevel } from "@/lib/pricesProtocol";
import { fmtDepthPrice } from "./depthFormat";

type MontageLevel = DepthLevel & { firstOfLevel: boolean; nbbo?: boolean };

/**
 * Two-sided montage for stocks (exchange / MPID L2 depth) and options
 * (per-exchange BBO). The two render identically except: stocks draw the
 * price-level edge marker (`firstOfLevel`) and treat index 0 as best; options
 * suppress the edge marker and trust the per-row `nbbo` best-rule.
 */
export function DepthMontage({ book }: { book: DepthBook }) {
  const bids = groupPriceLevels(book.bid) as MontageLevel[];
  const asks = groupPriceLevels(book.ask) as MontageLevel[];
  const maxSize = Math.max(
    ...book.bid.map((l) => l.size),
    ...book.ask.map((l) => l.size),
    1,
  );
  const isOption = book.kind === "option";

  const row = (level: MontageLevel, side: "bid" | "ask", index: number) => {
    const fill = Math.round(montageFill(level, maxSize) * 55);
    const best = isBestLevel(level, index, book.kind);
    const lvlfirst = !isOption && level.firstOfLevel ? 1 : 0;
    const mkt = level.marketMaker ?? level.exchange ?? "--";
    const cells =
      side === "bid"
        ? [
            <span className="book-mkt" key="m">{mkt}</span>,
            <span className="book-shares" key="s">{level.size}</span>,
            <span className="book-px" key="p">{fmtDepthPrice(level.price)}</span>,
          ]
        : [
            <span className="book-px" key="p">{fmtDepthPrice(level.price)}</span>,
            <span className="book-shares" key="s">{level.size}</span>,
            <span className="book-mkt" key="m">{mkt}</span>,
          ];
    return (
      <div
        className={`book-row book-reveal${best ? " best" : ""}`}
        data-lvlfirst={lvlfirst}
        style={{ ["--fill" as string]: fill, ["--i" as string]: index }}
        key={`${side}-${index}`}
      >
        {cells}
      </div>
    );
  };

  return (
    <div className="book-sides">
      <div className="book-side bid">
        <div className="book-colhead">
          <span>Market</span>
          <span className="r">Shares</span>
          <span className="r">Bid</span>
        </div>
        {bids.map((level, i) => row(level, "bid", i))}
      </div>
      <div className="book-side ask">
        <div className="book-colhead">
          <span>Ask</span>
          <span className="r">Shares</span>
          <span className="r">Market</span>
        </div>
        {asks.map((level, i) => row(level, "ask", i))}
      </div>
    </div>
  );
}
