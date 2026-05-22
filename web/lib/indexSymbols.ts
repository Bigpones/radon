/**
 * Canonical list of index symbols that IBKR treats as `secType=IND`
 * (not `STK`). Subscribing to these as stocks returns no data;
 * subscribing via the index path (`reqMktData` on `Index(symbol, exchange, currency)`)
 * works.
 *
 * Used by:
 *  - `WorkspaceShell` to route the `/[ticker]` subscription through
 *    `indexes` instead of `symbols` when the ticker is a known index.
 *  - `OrderTab` / `BookTab` to hide trading affordances since indices
 *    themselves are not tradeable (only futures / options on the index).
 *  - `lib/indexSymbols.test.ts` keeps the list in sync with the Python
 *    counterpart at `scripts/utils/index_symbols.py`.
 *
 * IMPORTANT: this is the set of indices Radon currently knows about.
 * Adding a new one requires:
 *   1. Adding it here AND in `scripts/utils/index_symbols.py`
 *   2. Confirming the user's IBKR account has the matching market-data
 *      subscription (CBOE Indexes for VIX/VVIX/SPX, etc.).
 */

export type IndexExchange = "CBOE" | "NASDAQ" | "NYSE" | "RUSSELL";

export const INDEX_SYMBOLS: Record<string, IndexExchange> = {
  // Volatility (CBOE Indexes feed)
  VIX: "CBOE",
  VVIX: "CBOE",
  VXX: "CBOE", // ETN — but tracked like an index for quote purposes here
  COR1M: "CBOE",
  COR3M: "CBOE",
  SKEW: "CBOE",
  // Broad-market indices
  SPX: "CBOE",
  NDX: "NASDAQ",
  RUT: "RUSSELL",
  DJX: "CBOE",
  OEX: "CBOE",
  XSP: "CBOE", // mini-SPX
};

/** True iff the symbol is one IBKR exposes via `secType=IND`. */
export function isIndexSymbol(symbol: string | null | undefined): boolean {
  if (!symbol) return false;
  return symbol.toUpperCase() in INDEX_SYMBOLS;
}

/** Exchange code IBKR expects for an index symbol; null when unknown. */
export function indexExchangeFor(symbol: string | null | undefined): IndexExchange | null {
  if (!symbol) return null;
  const upper = symbol.toUpperCase();
  return INDEX_SYMBOLS[upper] ?? null;
}
