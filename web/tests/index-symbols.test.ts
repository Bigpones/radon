import { describe, it, expect } from "vitest";
import { isIndexSymbol, indexExchangeFor, INDEX_SYMBOLS } from "../lib/indexSymbols";

describe("isIndexSymbol", () => {
  it("returns true for canonical index symbols", () => {
    expect(isIndexSymbol("VIX")).toBe(true);
    expect(isIndexSymbol("VVIX")).toBe(true);
    expect(isIndexSymbol("SPX")).toBe(true);
    expect(isIndexSymbol("NDX")).toBe(true);
    expect(isIndexSymbol("RUT")).toBe(true);
  });

  it("returns true for case-insensitive matches", () => {
    expect(isIndexSymbol("vix")).toBe(true);
    expect(isIndexSymbol("Spx")).toBe(true);
  });

  it("returns false for equity symbols", () => {
    expect(isIndexSymbol("AAPL")).toBe(false);
    expect(isIndexSymbol("TSLA")).toBe(false);
    expect(isIndexSymbol("SPY")).toBe(false); // ETF that TRACKS SPX — but tradeable as stock
  });

  it("returns false for null/empty input", () => {
    expect(isIndexSymbol(null)).toBe(false);
    expect(isIndexSymbol(undefined)).toBe(false);
    expect(isIndexSymbol("")).toBe(false);
  });
});

describe("indexExchangeFor", () => {
  it("returns CBOE for volatility indices", () => {
    expect(indexExchangeFor("VIX")).toBe("CBOE");
    expect(indexExchangeFor("VVIX")).toBe("CBOE");
    expect(indexExchangeFor("COR1M")).toBe("CBOE");
  });

  it("returns NASDAQ for NDX", () => {
    expect(indexExchangeFor("NDX")).toBe("NASDAQ");
  });

  it("returns RUSSELL for RUT", () => {
    expect(indexExchangeFor("RUT")).toBe("RUSSELL");
  });

  it("returns null for unknown symbols", () => {
    expect(indexExchangeFor("AAPL")).toBeNull();
    expect(indexExchangeFor(null)).toBeNull();
  });

  it("normalises case before lookup", () => {
    expect(indexExchangeFor("vix")).toBe("CBOE");
  });
});

describe("INDEX_SYMBOLS table", () => {
  it("includes the four indices the regime tab subscribes to", () => {
    // WorkspaceShell hardcodes these for the Regime tab — keep them
    // in the index table so /VIX / /VVIX / /COR1M pages also resolve.
    expect(Object.keys(INDEX_SYMBOLS)).toEqual(
      expect.arrayContaining(["VIX", "VVIX", "COR1M"]),
    );
  });
});
