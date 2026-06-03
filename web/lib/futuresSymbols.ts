/**
 * Futures roots Radon routes to the centered price-ladder DOM (`<LadderDOM>`).
 *
 * These are the relay-supported native-depth futures (single-venue depth via
 * `reqMktDepth(isSmartDepth=false)`), minus VIX — VIX is carried as an index
 * (`secType=IND`) with no `reqMktDepth`, so it degrades to the L1 fallback.
 *
 * This list is the PRE-DEPTH HINT only: it tells `TickerDetailContent` to
 * resolve `bookKind="future"` and subscribe depth for the root before any
 * `DepthBook` has arrived. Once depth streams, `DepthBook.kind` from the relay
 * is authoritative (`depth.kind === "future"` wins).
 *
 * Keep conceptually in sync with the relay's `DEPTH_FUTURES_SYMBOLS`
 * (`scripts/ib_realtime_server.js`). The relay set additionally carries `VIX`
 * (IB's contract symbol for the VIX future, on CFE); Radon's UI reaches VIX
 * through the index path, so it is intentionally excluded here.
 */
export const FUTURES_ROOTS = new Set([
  "ES", // E-mini S&P 500
  "NQ", // E-mini Nasdaq-100
  "RTY", // E-mini Russell 2000
  "YM", // E-mini Dow
  "CL", // Crude Oil
  "GC", // Gold
  "ZB", // 30Y T-Bond
  "ZN", // 10Y T-Note
]);

/** True iff the symbol is a futures root Radon routes to the ladder DOM. */
export function isFuturesRoot(symbol: string | null | undefined): boolean {
  if (!symbol) return false;
  return FUTURES_ROOTS.has(symbol.toUpperCase());
}
