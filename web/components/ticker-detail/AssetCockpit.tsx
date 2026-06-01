"use client";

import type { OpenOrder, PortfolioData, PortfolioPosition } from "@/lib/types";
import type { PriceData, FundamentalsData, DepthBook, Trade } from "@/lib/pricesProtocol";
import type { QuoteFallback } from "@/lib/quoteTelemetry";
import BookTab from "./BookTab";
import OrderTab from "./OrderTab";
import ActHeldSummary from "./ActHeldSummary";
import CockpitHeader from "./CockpitHeader";
import GlyphRail from "./GlyphRail";
import AssetDeck from "./AssetDeck";

/** Deck keys map 1:1 to the glyph rail + URL deck param. */
export type DeckKey = "c" | "p" | "n" | "r" | "s" | "i" | ":";

export type AssetCockpitProps = {
  ticker: string;
  position: PortfolioPosition | null;
  prices: Record<string, PriceData>;
  fundamentals: Record<string, FundamentalsData>;
  portfolio: PortfolioData | null;
  depths?: Record<string, DepthBook>;
  tape?: Record<string, Trade[]>;
  bookKey: string;
  bookKind: "stock" | "option" | "future";
  /** Depth-NBBO-corrected quote; single source for the header scalars. */
  quotePriceData: PriceData | null;
  /** Resolved option/underlying price data threaded to the ticket + book. */
  priceData: PriceData | null;
  isSpreadNet?: boolean;
  tickerOrders: OpenOrder[];
  /** After-hours OHLV fallback (header already prefers depth-NBBO; reserved). */
  stockFallback?: QuoteFallback | null;
  theme: "dark" | "light";
  activeDeck: DeckKey | null;
  onDeckChange: (deck: DeckKey | null) => void;
};

export default function AssetCockpit({
  ticker,
  position,
  prices,
  fundamentals,
  portfolio,
  depths,
  tape,
  bookKey,
  bookKind,
  quotePriceData,
  priceData,
  isSpreadNet,
  tickerOrders,
  activeDeck,
  onDeckChange,
}: AssetCockpitProps) {
  const live = (quotePriceData?.bid != null && quotePriceData?.ask != null) || quotePriceData?.last != null;

  return (
    <div className="cockpit cockpit-host">
      <CockpitHeader
        ticker={ticker}
        kind={bookKind}
        quotePriceData={quotePriceData}
        isSpreadNet={isSpreadNet}
        position={position}
        live={Boolean(live)}
        onDeckChange={onDeckChange}
      />

      {/* BOOK — montage/ladder + tape, full height; sole home of bid/ask depth. */}
      <div className="book-region">
        <BookTab
          ticker={ticker}
          position={position}
          prices={prices}
          openOrders={tickerOrders}
          tickerPriceData={priceData}
          depths={depths}
          tape={tape}
          bookKey={bookKey}
          bookKind={bookKind}
          portfolio={portfolio}
          bookOnly
        />
      </div>

      {/* ACT — ticket-focused, mirroring the flat futures view. The order ticket
          fills the top; below it a centered affordance: the "No position" cue when
          flat, or a single one-line held summary that links to the p-deck. The full
          position detail (legs / entry-mark-P&L cards / close-out) lives ONLY in the
          p-deck, reached here or via the header chip — never docked as a card grid. */}
      <div className="act-region">
        <div className="act-ticket">
          <OrderTab
            ticker={ticker}
            position={position}
            portfolio={portfolio}
            prices={prices}
            openOrders={tickerOrders}
            tickerPriceData={priceData}
          />
        </div>
        <div className="act-position">
          {position ? (
            <ActHeldSummary position={position} onOpenDeck={() => onDeckChange("p")} />
          ) : (
            <div className="act-flat">
              <span>No position</span>
              <span className="act-flat-hint">Ticket opens one ↑</span>
            </div>
          )}
        </div>
      </div>

      {/* Deck is a .cockpit grid child (sibling of book/act/rail). Narrow decks
          (position / news / ratings / info) pin to the `act` grid cell and overlay
          the act column exactly. WIDE decks — the options chain, which has ~10
          columns and overflows a 36% column — span the book + act cells so the
          full chain table fits without horizontal scroll. The rail (column 3)
          always stays visible. Grid children fill their cell, so no transform /
          inset math is needed; the reveal is opacity-only. */}
      <AssetDeck
        activeDeck={activeDeck}
        onDeckChange={onDeckChange}
        ticker={ticker}
        prices={prices}
        fundamentals={fundamentals}
        portfolio={portfolio}
        position={position}
        quotePriceData={quotePriceData}
      />

      <GlyphRail activeDeck={activeDeck} onDeckChange={onDeckChange} />
    </div>
  );
}
